"""AWS Polly text-to-speech.

`synthesize(text, gender)` returns mp3 bytes ready to stream to the browser.
Voice selection is driven by persona gender; configured names live in settings
(default Joanna / Matthew, neural engine).
"""
from __future__ import annotations

import asyncio
import logging

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings

logger = logging.getLogger(__name__)


def _polly_client():
    kwargs = {}
    if settings.AWS_REGION:
        kwargs["region_name"] = settings.AWS_REGION
    return boto3.client("polly", **kwargs)


def _pick_voice(gender: str | None) -> str:
    if gender and gender.lower() == "female":
        return settings.POLLY_VOICE_FEMALE
    return settings.POLLY_VOICE_MALE


def _synthesize_sync(text: str, gender: str | None) -> bytes:
    client = _polly_client()
    voice = _pick_voice(gender)
    try:
        resp = client.synthesize_speech(
            Text=text,
            VoiceId=voice,
            OutputFormat="mp3",
            Engine=settings.POLLY_ENGINE,
        )
    except (BotoCoreError, ClientError) as e:
        logger.exception("Polly synthesis failed for voice=%s", voice)
        raise RuntimeError(f"TTS failed: {e}") from e

    stream = resp.get("AudioStream")
    if stream is None:
        raise RuntimeError("Polly returned no AudioStream")
    return stream.read()


async def synthesize(text: str, gender: str | None = None) -> bytes:
    """Async wrapper around Polly. Returns mp3 bytes."""
    if not text or not text.strip():
        raise ValueError("text is required")
    # Polly has a 3000-char limit for single requests; truncate if needed.
    if len(text) > 2900:
        text = text[:2900].rsplit(" ", 1)[0]
    return await asyncio.to_thread(_synthesize_sync, text, gender)
