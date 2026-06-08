"""POST /api/tts — synthesize speech via Polly or Deepgram Aura-2.

The provider is chosen by the ``TTS_PROVIDER`` setting (default ``polly``).
A per-request ``X-TTS-Provider`` header overrides for that call so we can
A/B benchmark side-by-side without flipping the global flag.

When Aura-2 is selected but DEEPGRAM_API_KEY is missing, we fall back to
Polly silently so a misconfiguration never bricks the app.
"""
import asyncio
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from app.auth import require_advisor_or_admin
from app.config import settings
from app.models import User
from app.services import aura_streaming_service as aura
from app.services import elevenlabs_service as elevenlabs
from app.services import tts_service as polly

logger = logging.getLogger(__name__)
router = APIRouter()


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000)
    gender: str | None = None      # "male" / "female"
    age_group: str | None = None   # "young_adult" / "middle_aged" / "senior" / "elderly"


def _resolve_provider(override: str | None) -> str:
    """Pick which provider serves this request. Resolution order:
      1. X-TTS-Provider header (per-request override, A/B testing)
      2. TTS_PROVIDER setting (global default)
      3. polly (safety net)
    Falls back to polly if the requested provider's key isn't configured."""
    requested = (override or settings.TTS_PROVIDER or "polly").strip().lower()
    if requested == "elevenlabs" and not elevenlabs.is_available():
        logger.warning("elevenlabs requested but ELEVENLABS_API_KEY missing — falling back to polly")
        return "polly"
    if requested == "aura" and not aura.is_available():
        logger.warning("aura requested but DEEPGRAM_API_KEY missing — falling back to polly")
        return "polly"
    return requested if requested in {"polly", "aura", "elevenlabs"} else "polly"


@router.post("", response_class=Response)
async def tts(
    payload: TTSRequest,
    x_tts_provider: str | None = Header(default=None, alias="X-TTS-Provider"),
    _: User = Depends(require_advisor_or_admin),
):
    provider = _resolve_provider(x_tts_provider)
    logger.info(
        "TTS req provider=%s gender=%r age_group=%r chars=%d preview=%r",
        provider, payload.gender, payload.age_group, len(payload.text),
        payload.text[:60],
    )
    try:
        if provider == "elevenlabs":
            audio = await elevenlabs.synthesize(payload.text, payload.gender, payload.age_group)
        elif provider == "aura":
            audio = await aura.synthesize(payload.text, payload.gender, payload.age_group)
        else:
            audio = await polly.synthesize(payload.text, payload.gender, payload.age_group)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "X-TTS-Provider": provider},
    )


@router.post("/marks", response_model=dict)
async def tts_marks(
    payload: TTSRequest,
    x_tts_provider: str | None = Header(default=None, alias="X-TTS-Provider"),
    _: User = Depends(require_advisor_or_admin),
):
    """Returns viseme + word speech marks. Polly emits these natively; Aura-2
    returns an empty list (the frontend skips lip-sync animation when empty —
    Phase B's HeyGen avatar owns the face entirely)."""
    provider = _resolve_provider(x_tts_provider)
    try:
        if provider == "elevenlabs":
            marks = await elevenlabs.fetch_visemes(payload.text, payload.gender, payload.age_group)
        elif provider == "aura":
            marks = await aura.fetch_visemes(payload.text, payload.gender, payload.age_group)
        else:
            marks = await polly.fetch_visemes(payload.text, payload.gender, payload.age_group)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    return {"marks": marks, "provider": provider}


@router.post("/stream")
async def tts_stream(
    payload: TTSRequest,
    x_tts_provider: str | None = Header(default=None, alias="X-TTS-Provider"),
    _: User = Depends(require_advisor_or_admin),
):
    """Streaming TTS endpoint. Returns chunked raw PCM (linear16, 24kHz,
    mono) — the browser plays each chunk via Web Audio API as it arrives,
    giving sub-300ms time to first audio.

    Provider is chosen by the X-TTS-Provider header (per-request) or the
    TTS_PROVIDER setting. Both ElevenLabs Flash v2.5 and Deepgram Aura-2
    support streaming PCM; Polly does not, so a Polly request to this
    endpoint returns 502 (the frontend then falls back to /api/tts).
    """
    # Resolve provider — but for /stream, default to ElevenLabs when
    # configured (best naturalness in this latency tier), otherwise Aura.
    # Polly can't stream, so a polly request to this endpoint 502s.
    requested = (
        x_tts_provider
        or (settings.TTS_PROVIDER if settings.TTS_PROVIDER in {"elevenlabs", "aura"} else "")
        or ("elevenlabs" if elevenlabs.is_available() else "aura")
    ).strip().lower()

    if requested == "elevenlabs" and not elevenlabs.is_available():
        requested = "aura"
    if requested == "aura" and not aura.is_available():
        if elevenlabs.is_available():
            requested = "elevenlabs"
        else:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Streaming TTS unavailable (no provider key configured)",
            )

    chosen_label = "elevenlabs-flash" if requested == "elevenlabs" else "aura-ws"
    streamer = elevenlabs.stream_pcm if requested == "elevenlabs" else aura.stream_pcm

    async def generator():
        try:
            async for chunk in streamer(
                payload.text, payload.gender, payload.age_group,
            ):
                yield chunk
        except asyncio.CancelledError:
            raise
        except RuntimeError as e:
            # By the time we're streaming we've already sent 200 OK, so we
            # can't change the status. Log + truncate.
            logger.warning("%s stream errored mid-flight: %s", chosen_label, e)
            return

    return StreamingResponse(
        generator(),
        media_type="audio/L16",
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Encoding": "linear16",
            "X-Audio-Sample-Rate": "24000",
            "X-Audio-Channels": "1",
            "X-TTS-Provider": chosen_label,
        },
    )


class BenchmarkRequest(BaseModel):
    text: str = Field(
        default=(
            "Thanks for taking the time to meet today. I've been thinking a lot "
            "about retirement lately and a friend suggested I come talk to you."
        ),
        min_length=1,
        max_length=2000,
    )
    runs: int = Field(default=10, ge=1, le=50)
    gender: str = "female"
    age_group: str = "middle_aged"


@router.post("/benchmark", response_model=dict)
async def tts_benchmark(
    payload: BenchmarkRequest,
    _: User = Depends(require_advisor_or_admin),
):
    """Run a synthesis latency benchmark against Aura-2 (and Polly for
    comparison). Useful to validate the sub-600ms acceptance criterion
    before flipping ``TTS_PROVIDER`` globally."""
    result: dict = {"text_chars": len(payload.text), "runs": payload.runs}

    # Aura-2 leg
    if aura.is_available():
        result["aura"] = await aura.benchmark(
            payload.text, payload.runs, payload.gender, payload.age_group,
        )
    else:
        result["aura"] = {"skipped": "DEEPGRAM_API_KEY not set"}

    # Polly leg (same prompt, same voice bucket) — apples-to-apples baseline
    import statistics, time
    latencies: list[float] = []
    polly_errors: list[str] = []
    try:
        await polly.synthesize(payload.text, payload.gender, payload.age_group)  # warmup
    except Exception as e:  # noqa: BLE001
        polly_errors.append(f"warmup: {e}")
    for _ in range(payload.runs):
        t0 = time.perf_counter()
        try:
            await polly.synthesize(payload.text, payload.gender, payload.age_group)
            latencies.append((time.perf_counter() - t0) * 1000.0)
        except Exception as e:  # noqa: BLE001
            polly_errors.append(str(e))
    if latencies:
        latencies.sort()
        n = len(latencies)
        result["polly"] = {
            "p50_ms": round(latencies[n // 2], 1),
            "p95_ms": round(latencies[min(n - 1, int(n * 0.95))], 1),
            "mean_ms": round(statistics.mean(latencies), 1),
            "min_ms": round(min(latencies), 1),
            "max_ms": round(max(latencies), 1),
            "errors": polly_errors,
        }
    else:
        result["polly"] = {"error": "all runs failed", "errors": polly_errors}
    return result
