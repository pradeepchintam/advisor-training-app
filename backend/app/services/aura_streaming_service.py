"""Deepgram Aura-2 text-to-speech (Phase A of the voice upgrade).

Drop-in replacement for ``tts_service.synthesize`` with the same async
signature. We use the HTTP endpoint (``POST /v1/speak``) — the request body
is short JSON, the response is the synthesized audio bytes, and latency
clocks in around 200–400ms end-to-end for sentence-sized chunks (vs Polly's
1–3s). True WebSocket streaming with chunked PCM is the Phase A.5 upgrade;
HTTP first lets us swap with zero changes to the existing audio pipeline.

Voice picker mirrors the (gender, age_group) matrix from ``tts_service`` so
the dispatcher can route between providers transparently. Aura-2 has no
SSML / speech-rate control, so the age effect comes purely from voice
choice — we pick warmer, more measured voices for senior/elderly.

Visemes: Aura-2 doesn't emit speech marks, so ``fetch_visemes`` returns an
empty list. The frontend already handles empty marks (static mouth, no
overlay animation), which is what we want anyway once HeyGen LiveAvatar
lands in Phase B.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

ItemKey = tuple[str, str]  # (gender, age_group)

# ---------------------------------------------------------------------------
# Voice matrix — Aura-2 en-US voices.
# Picked to match the Polly matrix's age + gender semantics:
#   • luna   — warm, conversational young adult female
#   • thalia — clear professional middle-aged female (Deepgram's flagship)
#   • hera   — mature, slower-paced female
#   • arcas  — friendly young male
#   • orion  — natural conversational middle-aged male
#   • orpheus — deeper, measured older-sounding male
# ---------------------------------------------------------------------------
_AURA_VOICES: dict[ItemKey, str] = {
    ("female", "young_adult"): "aura-2-luna-en",
    ("female", "middle_aged"): "aura-2-thalia-en",
    ("female", "senior"):      "aura-2-hera-en",
    ("female", "elderly"):     "aura-2-hera-en",
    ("male",   "young_adult"): "aura-2-arcas-en",
    ("male",   "middle_aged"): "aura-2-orion-en",
    ("male",   "senior"):      "aura-2-orpheus-en",
    ("male",   "elderly"):     "aura-2-orpheus-en",
}

_DEFAULT_VOICE = "aura-2-thalia-en"


def _normalize(value: str | None, allowed: set[str], default: str) -> str:
    v = (value or "").strip().lower().replace("-", "_")
    return v if v in allowed else default


def _pick_voice(gender: str | None, age_group: str | None) -> str:
    g = _normalize(gender, {"male", "female"}, "male")
    a = _normalize(
        age_group,
        {"young_adult", "middle_aged", "senior", "elderly"},
        "middle_aged",
    )
    return _AURA_VOICES.get((g, a), _DEFAULT_VOICE)


def is_available() -> bool:
    """True when Aura-2 can actually serve requests. Used by the dispatcher
    to fall back to Polly if the key is missing."""
    return bool((settings.DEEPGRAM_API_KEY or "").strip())


# ---------------------------------------------------------------------------
# Synthesis
# ---------------------------------------------------------------------------

# Module-level client so connection pooling kicks in across calls — saves
# ~50-100ms on TCP/TLS handshake per request after the first.
_http_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        async with _client_lock:
            if _http_client is None or _http_client.is_closed:
                _http_client = httpx.AsyncClient(
                    http2=False,  # Deepgram HTTP/1.1 + keep-alive is plenty
                    timeout=httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0),
                    limits=httpx.Limits(
                        max_keepalive_connections=20,
                        max_connections=40,
                        keepalive_expiry=60.0,
                    ),
                )
    return _http_client


async def synthesize(
    text: str,
    gender: str | None = None,
    age_group: str | None = None,
) -> bytes:
    """Synthesize MP3 audio via Aura-2.

    Returns raw mp3 bytes ready for ``audio/mpeg`` Response. Same contract
    as ``tts_service.synthesize`` so the dispatcher can route either path.
    """
    if not text or not text.strip():
        raise ValueError("text is required")
    if not is_available():
        raise RuntimeError("Deepgram Aura-2 is not configured (DEEPGRAM_API_KEY unset)")

    voice = _pick_voice(gender, age_group)
    # Cap at 2000 chars — Aura's request body limit is generous, but the
    # frontend streams sentence-by-sentence so we never approach this.
    if len(text) > 2000:
        text = text[:2000].rsplit(" ", 1)[0]

    # Note: Deepgram rejects `sample_rate` when `encoding=mp3` — the codec
    # has a fixed rate. Only pass sample_rate for linear PCM if we add it
    # later for the streaming-WebSocket path.
    params = {
        "model": voice,
        "encoding": "mp3",          # browser-native, plays out of <audio>
    }
    headers = {
        "Authorization": f"Token {settings.DEEPGRAM_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {"text": text}

    client = await _get_client()
    try:
        resp = await client.post(
            settings.DEEPGRAM_TTS_BASE_URL,
            params=params,
            headers=headers,
            json=body,
        )
    except httpx.HTTPError as e:
        logger.exception("Aura-2 synthesis network error voice=%s", voice)
        raise RuntimeError(f"Aura-2 network error: {e}") from e

    if resp.status_code != 200:
        snippet = (resp.text or "")[:300]
        logger.warning(
            "Aura-2 returned %d for voice=%s: %s",
            resp.status_code, voice, snippet,
        )
        raise RuntimeError(
            f"Aura-2 returned {resp.status_code}: {snippet}"
        )
    return resp.content


async def fetch_visemes(
    text: str,
    gender: str | None = None,
    age_group: str | None = None,
) -> list[dict]:
    """Aura-2 has no native viseme output — return empty so the frontend
    skips lip-sync animation entirely. (This is fine; the photo overlay
    looks worse than a static mouth anyway, and Phase B replaces it with
    HeyGen LiveAvatar which owns the face directly.)"""
    return []


# ---------------------------------------------------------------------------
# Phase A.5 — WebSocket streaming TTS
# ---------------------------------------------------------------------------
# Aura-2's WebSocket endpoint streams PCM audio chunks as the synthesis runs
# — the first chunk lands ~150–300ms after the request rather than ~1.5–3s
# for the HTTP path. We open one WS per sentence, write the text, request a
# flush, and stream the binary frames back to the caller via an async
# generator. PCM is linear16 mono at 24kHz so the browser can play it
# directly via Web Audio API (no MP3 decoder needed).

DEEPGRAM_TTS_WS_URL = "wss://api.deepgram.com/v1/speak"

# Linear16 PCM @ 24kHz, mono. Matches what Deepgram emits and what the
# frontend AudioContext is configured to play. Don't add ?container= — the
# default for linear16 is "none" (raw PCM, no wrapper) which is what we want.
_WS_PARAMS = {
    "encoding": "linear16",
    "sample_rate": "24000",
}

# How long to wait between the last text we sent and the audio response
# completing. Deepgram flushes within 200-500ms of `Flush` in practice;
# we cap higher so a slow round-trip doesn't kill a long-ish sentence.
_RESPONSE_TIMEOUT_S = 15.0


async def stream_pcm(
    text: str,
    gender: str | None = None,
    age_group: str | None = None,
):
    """Async generator yielding PCM (linear16, 24kHz, mono) bytes for
    `text` via Aura-2's WebSocket endpoint.

    Usage::

        async for chunk in stream_pcm("Hi there.", gender="female", age_group="middle_aged"):
            await ws.send_bytes(chunk)

    The first chunk typically arrives ~150–300ms after the call —
    significantly faster than the HTTP path's wait-for-full-audio. The
    generator finishes when Deepgram sends the `Flushed` status message
    or the WS closes.
    """
    if not text or not text.strip():
        return
    if not is_available():
        raise RuntimeError("Deepgram Aura-2 is not configured (DEEPGRAM_API_KEY unset)")

    import json as _json
    from urllib.parse import urlencode
    import websockets

    voice = _pick_voice(gender, age_group)
    params = {**_WS_PARAMS, "model": voice}
    url = f"{DEEPGRAM_TTS_WS_URL}?{urlencode(params)}"
    headers = [("Authorization", f"Token {settings.DEEPGRAM_API_KEY}")]

    # 2KB cap matches the HTTP path. Per-sentence chunks are typically
    # 30-200 chars so we never approach this.
    if len(text) > 2000:
        text = text[:2000].rsplit(" ", 1)[0]

    try:
        async with websockets.connect(
            url,
            additional_headers=headers,
            max_size=8 * 1024 * 1024,  # accept up to 8MB of audio per chunk
            open_timeout=5.0,
            close_timeout=2.0,
        ) as ws:
            # 1. Send the text to synthesize.
            await ws.send(_json.dumps({"type": "Speak", "text": text}))
            # 2. Tell Deepgram we're done writing and want the rest of the
            #    audio flushed immediately. Without this, Aura would wait
            #    for more text (it's a true streaming endpoint).
            await ws.send(_json.dumps({"type": "Flush"}))

            # 3. Drain binary audio frames until we see the `Flushed`
            #    status message or the connection closes.
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=_RESPONSE_TIMEOUT_S)
                if isinstance(msg, bytes):
                    if msg:
                        yield msg
                    continue
                # JSON status message — check for completion.
                try:
                    data = _json.loads(msg)
                except Exception:  # noqa: BLE001
                    continue
                if data.get("type") == "Flushed":
                    # All requested audio has been sent. Close cleanly.
                    try:
                        await ws.send(_json.dumps({"type": "Close"}))
                    except Exception:  # noqa: BLE001
                        pass
                    return
                if data.get("type") in {"Error", "Warning"}:
                    logger.warning("Aura-2 WS message: %s", data)
                    if data.get("type") == "Error":
                        raise RuntimeError(f"Aura-2 WS error: {data.get('description', data)}")
    except websockets.exceptions.ConnectionClosedOK:
        return
    except asyncio.CancelledError:
        # Barge-in: the caller cancelled us. Let the context-manager close
        # the WS cleanly on the way out.
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("Aura-2 WS stream failed for voice=%s", voice)
        raise RuntimeError(f"Aura-2 streaming failed: {e}") from e


async def benchmark(
    text: str,
    runs: int = 10,
    gender: str = "female",
    age_group: str = "middle_aged",
) -> dict:
    """Fire `runs` sequential synthesis requests and return latency stats.

    Used by the /api/tts/benchmark endpoint to validate the sub-600ms
    end-to-end ceiling before flipping TTS_PROVIDER globally. Sequential
    (not parallel) so we measure single-request behavior, not best-case
    parallelism.
    """
    import statistics
    import time

    if not is_available():
        return {"error": "DEEPGRAM_API_KEY not configured"}

    latencies_ms: list[float] = []
    sizes: list[int] = []
    errors: list[str] = []
    voice = _pick_voice(gender, age_group)

    # One warm-up to populate the connection pool — keep-alive saves
    # ~80ms TLS on subsequent requests and we want to measure steady state.
    try:
        await synthesize(text, gender, age_group)
    except Exception as e:  # noqa: BLE001
        errors.append(f"warmup: {e}")

    for _ in range(runs):
        t0 = time.perf_counter()
        try:
            audio = await synthesize(text, gender, age_group)
            dt_ms = (time.perf_counter() - t0) * 1000.0
            latencies_ms.append(dt_ms)
            sizes.append(len(audio))
        except Exception as e:  # noqa: BLE001
            errors.append(str(e))

    if not latencies_ms:
        return {"error": "all runs failed", "errors": errors}

    latencies_ms.sort()
    n = len(latencies_ms)
    p50 = latencies_ms[n // 2]
    p95 = latencies_ms[min(n - 1, int(n * 0.95))]
    return {
        "voice": voice,
        "text_chars": len(text),
        "runs": n,
        "p50_ms": round(p50, 1),
        "p95_ms": round(p95, 1),
        "mean_ms": round(statistics.mean(latencies_ms), 1),
        "min_ms": round(min(latencies_ms), 1),
        "max_ms": round(max(latencies_ms), 1),
        "mean_audio_bytes": round(statistics.mean(sizes)) if sizes else 0,
        "errors": errors,
    }
