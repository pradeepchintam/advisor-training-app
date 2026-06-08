"""POST /api/tts/stream — streaming TTS via ElevenLabs Flash v2.5.

This is the sole TTS path in the system. Returns chunked raw PCM
(linear16, 24kHz, mono) — the browser plays each chunk via Web Audio
API as it arrives, giving sub-300ms time to first audio.

There are intentionally no fallback providers. Aura-2 and Polly were
removed when ElevenLabs became the chosen voice — if ElevenLabs is
unavailable (key rotated, network blip, plan quota exceeded), the
endpoint returns 502 and the session shows an error rather than
silently degrading to a worse voice.
"""
import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.auth import require_advisor_or_admin
from app.models import User
from app.services import elevenlabs_service as elevenlabs

logger = logging.getLogger(__name__)
router = APIRouter()


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000)
    gender: str | None = None      # "male" / "female"
    age_group: str | None = None   # "young_adult" / "middle_aged" / "senior" / "elderly"


@router.post("/stream")
async def tts_stream(
    payload: TTSRequest,
    _: User = Depends(require_advisor_or_admin),
):
    """Stream a sentence's audio via ElevenLabs Flash v2.5."""
    if not elevenlabs.is_available():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS unavailable (ELEVENLABS_API_KEY not configured)",
        )

    logger.info(
        "TTS stream gender=%r age_group=%r chars=%d preview=%r",
        payload.gender, payload.age_group, len(payload.text), payload.text[:60],
    )

    async def generator():
        try:
            async for chunk in elevenlabs.stream_pcm(
                payload.text, payload.gender, payload.age_group,
            ):
                yield chunk
        except asyncio.CancelledError:
            # Barge-in — caller aborted via AbortController.
            raise
        except RuntimeError as e:
            # We've already sent 200 OK by the time bytes start flowing,
            # so we can't change the status. Truncated audio + log entry.
            logger.warning("ElevenLabs stream errored mid-flight: %s", e)
            return

    return StreamingResponse(
        generator(),
        media_type="audio/L16",
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Encoding": "linear16",
            "X-Audio-Sample-Rate": "24000",
            "X-Audio-Channels": "1",
            "X-TTS-Provider": "elevenlabs-flash",
        },
    )
