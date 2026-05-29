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


def _visemes_sync(text: str, gender: str | None) -> list[dict]:
    """Fetch viseme + word speech marks for the same text/voice so the frontend
    can drive a lip-sync overlay against the audio's playback time."""
    import json
    client = _polly_client()
    voice = _pick_voice(gender)
    try:
        resp = client.synthesize_speech(
            Text=text,
            VoiceId=voice,
            OutputFormat="json",
            SpeechMarkTypes=["viseme", "word"],
            Engine=settings.POLLY_ENGINE,
        )
    except (BotoCoreError, ClientError) as e:
        logger.exception("Polly speech-marks request failed for voice=%s", voice)
        raise RuntimeError(f"TTS marks failed: {e}") from e

    stream = resp.get("AudioStream")
    if stream is None:
        return []
    raw = stream.read()
    # Polly returns newline-delimited JSON, one mark per line.
    marks: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            marks.append(json.loads(line.decode("utf-8") if isinstance(line, bytes) else line))
        except Exception:
            continue
    return marks


async def fetch_visemes(text: str, gender: str | None = None) -> list[dict]:
    """Async wrapper: returns Polly speech marks (visemes + words) for `text`.

    Each mark looks like: {"time": <ms>, "type": "viseme", "value": "k"} or
    {"time": <ms>, "type": "word", "start": int, "end": int, "value": str}.
    """
    if not text or not text.strip():
        return []
    if len(text) > 2900:
        text = text[:2900].rsplit(" ", 1)[0]
    return await asyncio.to_thread(_visemes_sync, text, gender)
