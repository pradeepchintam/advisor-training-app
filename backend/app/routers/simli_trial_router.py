"""Simli realtime avatar — LOCAL TRIAL ONLY.

Isolated spike to evaluate a photoreal talking-head avatar driven by the
existing ElevenLabs voice. Two avatars (couple) render side-by-side and are
driven by ElevenLabs audio routed to whichever partner is speaking.

Flow:
  POST /api/simli-trial/start -> mint TWO Simli session tokens (one preset
                                 female face for the wife, one male for the
                                 husband). API key stays server-side.
  POST /api/simli-trial/say   -> {text, speaker} -> ElevenLabs PCM16 @16kHz
                                 (the format Simli wants) -> returned to the
                                 browser, which streams it into that avatar.

Preset Simli faces are used for the trial (custom per-persona faces require
a >=512px source image; our persona photos are 128px). Custom faces are
confirmed working on the free tier and can be swapped in later.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel

from app.auth import require_advisor_or_admin
from app.config import settings
from app.models import User
from app.services import elevenlabs_service as eleven

logger = logging.getLogger("trajan.simli_trial")
router = APIRouter()

# Preset Simli faces (public, available to all accounts).
FACE_FEMALE = "cace3ef7-a4c4-425d-a8cf-a5358eb0c427"  # Tina
FACE_MALE = "1c6aa65c-d858-4721-a4d9-bda9fde03141"    # Fred


class SayRequest(BaseModel):
    text: str
    speaker: str = "primary"  # "primary" | "spouse"
    # Persona genders so the voice matches the avatar (Tina=female, Fred=male).
    primary_gender: str = "female"
    spouse_gender: str = "male"


def _simli_key() -> str:
    key = (settings.SIMLI_API_KEY or "").strip()
    if not key:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Simli not configured (SIMLI_API_KEY unset)",
        )
    return key


async def _start_session(key: str, face_id: str) -> str:
    """Create one Simli audio->video session, return its session_token."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.SIMLI_BASE_URL}/startAudioToVideoSession",
            json={
                "apiKey": key,
                "faceId": face_id,
                "handleSilence": True,
                "maxSessionLength": 1800,
                "maxIdleTime": 300,
            },
        )
    if resp.status_code != 200:
        logger.warning("Simli session failed %d: %s", resp.status_code, resp.text[:200])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Simli session error {resp.status_code}: {resp.text[:200]}",
        )
    return resp.json()["session_token"]


@router.post("/start", response_model=dict)
async def start_trial(_: User = Depends(require_advisor_or_admin)):
    """Mint two avatar sessions for the couple (Margaret=Tina, Tom=Fred)."""
    key = _simli_key()
    primary_token = await _start_session(key, FACE_FEMALE)
    spouse_token = await _start_session(key, FACE_MALE)
    return {
        "primary": {"name": "Margaret Smith", "session_token": primary_token, "face_id": FACE_FEMALE},
        "spouse": {"name": "Tom Smith", "session_token": spouse_token, "face_id": FACE_MALE},
    }


@router.post("/say")
async def say(payload: SayRequest, _: User = Depends(require_advisor_or_admin)):
    """Synthesize `text` in the speaker's voice as PCM16 @16kHz for Simli."""
    gender = payload.primary_gender if payload.speaker == "primary" else payload.spouse_gender
    # Senior couple — use a mature age bucket so the voice matches the persona.
    try:
        pcm = await eleven.synthesize_pcm16k(payload.text, gender, "senior")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    return Response(
        content=pcm,
        media_type="audio/L16",
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Encoding": "linear16",
            "X-Audio-Sample-Rate": "16000",
            "X-Audio-Channels": "1",
        },
    )
