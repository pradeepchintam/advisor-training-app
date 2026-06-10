"""ElevenLabs Flash v2.5 — streaming TTS.

Mirrors the contract of ``aura_streaming_service`` so the dispatcher can
route between providers transparently. Uses ElevenLabs' HTTP streaming
endpoint (chunked transfer-encoding) which returns raw PCM bytes as they're
synthesized — first chunk lands around 250–300ms in, matching Aura-2's
latency profile but with notably more natural prosody.

Why ElevenLabs over Aura: independent benchmarks (Coval, May 2026) rank
Flash v2.5 with the tightest latency variance (28ms IQR vs Aura's 68ms)
and the strongest subjective naturalness in the sub-500ms tier. Cost is
~2x Aura ($0.050 vs $0.030 per 1K chars) but at 50–300 hr/month that's
still under $50/mo.
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

ItemKey = tuple[str, str]


# ---------------------------------------------------------------------------
# Voice matrix — well-known ElevenLabs default-pool voice IDs. Matches the
# (gender × age_group) buckets used elsewhere. Hand-picked to feel
# appropriate for the financial-advisor training context (no novelty voices,
# no thick accents that distract from the script content).
# ---------------------------------------------------------------------------
_VOICES: dict[ItemKey, str] = {
    # Female — all confirmed accessible on free tier
    ("female", "young_adult"): "pFZP5JQG7iQjIQuC4Bku",  # Lily — warm, young
    ("female", "middle_aged"): "EXAVITQu4vr4xnSDxMaL",  # Sarah — clear, professional
    ("female", "senior"):      "XrExE9yKIg1WjnnlVkGX",  # Matilda — warm, mature
    ("female", "elderly"):     "XrExE9yKIg1WjnnlVkGX",  # Matilda — slowed via voice_settings
    # Male — all confirmed accessible
    ("male",   "young_adult"): "IKne3meq5aSn9XLyUdCD",  # Charlie — conversational young
    ("male",   "middle_aged"): "nPczCjzI2devNBz1zQrb",  # Brian — professional
    ("male",   "senior"):      "onwK4e9ZLuTAKqWW03F9",  # Daniel — British, mature
    ("male",   "elderly"):     "JBFqnCBsd6RMkjVDRZzb",  # George — deep, mature
}

_DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL"  # Sarah (free-tier accessible)


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
    return _VOICES.get((g, a), _DEFAULT_VOICE)


def _voice_settings(age_group: str | None) -> dict:
    """Voice settings (`stability`, `similarity_boost`, `style`) tuned per
    age bucket. Higher stability + lower style → slower, more deliberate
    pacing for senior/elderly. Lower stability → more expressive variation
    for younger voices."""
    a = _normalize(
        age_group,
        {"young_adult", "middle_aged", "senior", "elderly"},
        "middle_aged",
    )
    if a in ("senior", "elderly"):
        return {"stability": 0.65, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True}
    if a == "young_adult":
        return {"stability": 0.35, "similarity_boost": 0.75, "style": 0.40, "use_speaker_boost": True}
    return {"stability": 0.50, "similarity_boost": 0.75, "style": 0.25, "use_speaker_boost": True}


def is_available() -> bool:
    return bool((settings.ELEVENLABS_API_KEY or "").strip())


# ---------------------------------------------------------------------------
# Streaming TTS
# ---------------------------------------------------------------------------

# Module-level client — connection pooling saves ~50-100ms TLS handshake
# on subsequent sentences within the same session.
_http_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        async with _client_lock:
            if _http_client is None or _http_client.is_closed:
                _http_client = httpx.AsyncClient(
                    http2=False,
                    timeout=httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0),
                    limits=httpx.Limits(
                        max_keepalive_connections=20,
                        max_connections=40,
                        keepalive_expiry=60.0,
                    ),
                )
    return _http_client


async def stream_pcm(
    text: str,
    gender: str | None = None,
    age_group: str | None = None,
):
    """Async generator yielding PCM (linear16, 24kHz, mono) bytes for `text`
    via ElevenLabs' streaming HTTP endpoint. Same contract as
    ``aura_streaming_service.stream_pcm``.
    """
    if not text or not text.strip():
        return
    if not is_available():
        raise RuntimeError("ElevenLabs is not configured (ELEVENLABS_API_KEY unset)")

    voice_id = _pick_voice(gender, age_group)
    settings_obj = _voice_settings(age_group)

    # Cap at 5000 chars — ElevenLabs' per-request limit is well above this,
    # but our per-sentence chunks are always tiny.
    if len(text) > 5000:
        text = text[:5000].rsplit(" ", 1)[0]

    url = f"{settings.ELEVENLABS_BASE_URL}/text-to-speech/{voice_id}/stream"
    params = {
        "output_format": "pcm_24000",  # raw linear16 PCM, no container
        "optimize_streaming_latency": "3",  # max latency optimization
    }
    headers = {
        "xi-api-key": settings.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/pcm",
    }
    body = {
        "text": text,
        "model_id": settings.ELEVENLABS_MODEL_ID,
        "voice_settings": settings_obj,
    }

    client = await _get_client()
    try:
        async with client.stream(
            "POST", url, params=params, headers=headers, json=body,
        ) as resp:
            if resp.status_code != 200:
                # Drain the error body so we can surface a useful message
                # rather than just "non-200".
                err = await resp.aread()
                snippet = err.decode("utf-8", errors="replace")[:300]
                logger.warning(
                    "ElevenLabs returned %d for voice=%s: %s",
                    resp.status_code, voice_id, snippet,
                )
                raise RuntimeError(f"ElevenLabs returned {resp.status_code}: {snippet}")
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk
    except asyncio.CancelledError:
        # Barge-in: caller aborted. Let httpx clean up on the way out.
        raise
    except httpx.HTTPError as e:
        logger.exception("ElevenLabs network error voice=%s", voice_id)
        raise RuntimeError(f"ElevenLabs network error: {e}") from e


async def synthesize_pcm16k(
    text: str,
    gender: str | None = None,
    age_group: str | None = None,
) -> bytes:
    """Buffered synth returning raw PCM16 @ 16kHz mono — the exact format the
    Simli avatar's sendAudioData() expects. Used only by the avatar trial."""
    if not text or not text.strip():
        raise ValueError("text is required")
    if not is_available():
        raise RuntimeError("ElevenLabs is not configured (ELEVENLABS_API_KEY unset)")

    voice_id = _pick_voice(gender, age_group)
    settings_obj = _voice_settings(age_group)
    if len(text) > 5000:
        text = text[:5000].rsplit(" ", 1)[0]

    url = f"{settings.ELEVENLABS_BASE_URL}/text-to-speech/{voice_id}"
    params = {"output_format": "pcm_16000"}
    headers = {
        "xi-api-key": settings.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/pcm",
    }
    body = {
        "text": text,
        "model_id": settings.ELEVENLABS_MODEL_ID,
        "voice_settings": settings_obj,
    }
    client = await _get_client()
    try:
        resp = await client.post(url, params=params, headers=headers, json=body)
    except httpx.HTTPError as e:
        raise RuntimeError(f"ElevenLabs network error: {e}") from e
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs returned {resp.status_code}: {resp.text[:200]}")
    return resp.content


