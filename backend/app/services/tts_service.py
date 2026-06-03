"""AWS Polly text-to-speech.

`synthesize(text, gender, age_group)` returns mp3 bytes ready to stream to
the browser. Voice selection is driven by the persona's gender AND age
group, with optional SSML prosody to shift perceived age for older
personas (Polly has no dedicated "elderly" voice).
"""
from __future__ import annotations

import asyncio
import logging
from xml.sax.saxutils import escape as _xml_escape

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings

logger = logging.getLogger(__name__)


def _polly_client():
    kwargs = {}
    if settings.AWS_REGION:
        kwargs["region_name"] = settings.AWS_REGION
    return boto3.client("polly", **kwargs)


# ---------------------------------------------------------------------------
# Voice + prosody selection
# ---------------------------------------------------------------------------
# Polly neural en-US palette (as of 2025): Ivy (child F), Joanna, Kendra,
# Kimberly, Salli, Ruth, Danielle, Joey, Matthew, Stephen, Gregory, Kevin
# (child M). We pick deterministically by (gender, age_group) so the same
# persona always sounds the same across sessions.

# Map (gender, age_group) → (voice, prosody_rate, prosody_pitch).
# rate=None / pitch=None means "use plain text, no SSML wrapper".
# NOTE: Polly's neural engine supports SSML `rate` but NOT `pitch` — attempts
#       to set pitch raise InvalidSsmlException. We rely on rate (slower
#       speech) alone to age the voice; the voice change carries the rest.
_VOICE_MATRIX: dict[tuple[str, str], tuple[str, str | None, str | None]] = {
    # Female
    ("female", "young_adult"): ("Ruth",    None,  None),
    ("female", "middle_aged"): ("Joanna",  None,  None),
    ("female", "senior"):      ("Kendra",  "92%", None),
    ("female", "elderly"):     ("Kendra",  "85%", None),
    # Male
    ("male",   "young_adult"): ("Joey",    None,  None),
    ("male",   "middle_aged"): ("Matthew", None,  None),
    ("male",   "senior"):      ("Stephen", "92%", None),
    ("male",   "elderly"):     ("Stephen", "85%", None),
}


def _normalize(value: str | None, allowed: set[str], default: str) -> str:
    v = (value or "").strip().lower().replace("-", "_")
    return v if v in allowed else default


def _voice_settings(
    gender: str | None,
    age_group: str | None,
) -> tuple[str, str | None, str | None]:
    """Return (voice_id, ssml_rate, ssml_pitch). Falls back to the configured
    default voices when no matrix entry matches."""
    g = _normalize(gender, {"male", "female"}, "male")
    a = _normalize(
        age_group,
        {"young_adult", "middle_aged", "senior", "elderly"},
        "middle_aged",
    )
    key = (g, a)
    if key in _VOICE_MATRIX:
        return _VOICE_MATRIX[key]
    # Defensive default — never reached given the normalization above.
    default_voice = (
        settings.POLLY_VOICE_FEMALE if g == "female" else settings.POLLY_VOICE_MALE
    )
    return (default_voice, None, None)


def _wrap_ssml(text: str, rate: str | None, pitch: str | None) -> str:
    """Wrap plain text in an SSML <speak><prosody> envelope. Only called when
    rate/pitch is set (i.e. for senior/elderly personas)."""
    body = _xml_escape(text)
    attrs = []
    if rate:
        attrs.append(f'rate="{rate}"')
    if pitch:
        attrs.append(f'pitch="{pitch}"')
    if not attrs:
        return f"<speak>{body}</speak>"
    return f"<speak><prosody {' '.join(attrs)}>{body}</prosody></speak>"


def _build_request(
    text: str,
    gender: str | None,
    age_group: str | None,
) -> tuple[str, str, str]:
    """Return (text_or_ssml, text_type, voice_id) ready to pass to Polly."""
    voice, rate, pitch = _voice_settings(gender, age_group)
    if rate or pitch:
        return _wrap_ssml(text, rate, pitch), "ssml", voice
    return text, "text", voice


# ---------------------------------------------------------------------------
# Polly calls
# ---------------------------------------------------------------------------

def _synthesize_sync(text: str, gender: str | None, age_group: str | None) -> bytes:
    payload, text_type, voice = _build_request(text, gender, age_group)
    client = _polly_client()
    try:
        resp = client.synthesize_speech(
            Text=payload,
            TextType=text_type,
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


async def synthesize(
    text: str,
    gender: str | None = None,
    age_group: str | None = None,
) -> bytes:
    """Async wrapper around Polly. Returns mp3 bytes."""
    if not text or not text.strip():
        raise ValueError("text is required")
    # Polly has a 3000-char limit for single requests; truncate if needed.
    # The SSML envelope adds ~50 chars of overhead, so cap the body at 2800.
    if len(text) > 2800:
        text = text[:2800].rsplit(" ", 1)[0]
    return await asyncio.to_thread(_synthesize_sync, text, gender, age_group)


def _visemes_sync(text: str, gender: str | None, age_group: str | None) -> list[dict]:
    """Fetch viseme + word speech marks for the same text/voice so the frontend
    can drive a lip-sync overlay against the audio's playback time."""
    import json
    payload, text_type, voice = _build_request(text, gender, age_group)
    client = _polly_client()
    try:
        resp = client.synthesize_speech(
            Text=payload,
            TextType=text_type,
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


async def fetch_visemes(
    text: str,
    gender: str | None = None,
    age_group: str | None = None,
) -> list[dict]:
    """Async wrapper: returns Polly speech marks (visemes + words) for `text`.

    Each mark looks like: {"time": <ms>, "type": "viseme", "value": "k"} or
    {"time": <ms>, "type": "word", "start": int, "end": int, "value": str}.
    """
    if not text or not text.strip():
        return []
    if len(text) > 2800:
        text = text[:2800].rsplit(" ", 1)[0]
    return await asyncio.to_thread(_visemes_sync, text, gender, age_group)
