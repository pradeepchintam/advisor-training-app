"""ElevenLabs Conversational AI (Agents) — LOCAL TRIAL ONLY.

An isolated spike to evaluate whether ElevenLabs Agents can satisfy the two
non-negotiables — a couple voiced by two distinct ElevenLabs voices in one
live session, and full persona control with hosted Claude as the brain —
without touching the production cascade (Transcribe -> Claude -> ElevenLabs).

Flow:
  POST /api/agent-trial/start  -> (re)configure the trial agent with a couple
                                  persona prompt + two voices, then return a
                                  short-lived signed WebSocket URL the browser
                                  SDK connects to (browser <-> ElevenLabs cloud).

The agent runs ElevenLabs-hosted Claude, so nothing here needs a public
tunnel — the only outbound calls are this backend -> ElevenLabs REST API.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.auth import require_advisor_or_admin
from app.config import settings
from app.models import User

logger = logging.getLogger("trajan.agent_trial")
router = APIRouter()

CONVAI_BASE = "https://api.elevenlabs.io/v1/convai"

# A couple of free-tier-accessible ElevenLabs voices for the husband/wife.
# (Confirmed available to the convai key.)
PRIMARY_FEMALE = "EXAVITQu4vr4xnSDxMaL"  # Sarah — mature, reassuring
SPOUSE_MALE = "IKne3meq5aSn9XLyUdCD"     # Charlie — deep, confident
PRIMARY_MALE = "JBFqnCBsd6RMkjVDRZzb"    # George — warm storyteller
SPOUSE_FEMALE = "XrExE9yKIg1WjnnlVkGX"   # Matilda — professional


class TrialStartRequest(BaseModel):
    # Optional persona override. Defaults to Margaret & Tom Smith so the
    # trial works with zero input.
    primary_name: str = "Margaret Smith"
    primary_gender: str = "female"
    primary_personality: str = "anxious and reserved"
    spouse_name: str = "Tom Smith"
    spouse_gender: str = "male"
    spouse_personality: str = "analytical and cautious"
    situation: str = (
        "a recently-retired couple worried about whether their savings will "
        "last; here for a first meeting with a fiduciary advisor"
    )


def _convai_key() -> str:
    key = (settings.ELEVENLABS_CONVAI_API_KEY or "").strip()
    if not key:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="ElevenLabs Convai not configured (ELEVENLABS_CONVAI_API_KEY unset)",
        )
    return key


def _build_couple_prompt(r: TrialStartRequest) -> str:
    return (
        f"You are roleplaying a couple in a meeting with a fiduciary financial advisor: "
        f"{r.situation}.\n\n"
        f"PRIMARY — {r.primary_name} ({r.primary_gender}, {r.primary_personality}).\n"
        f"SPOUSE — {r.spouse_name} ({r.spouse_gender}, {r.spouse_personality}).\n\n"
        "RULES:\n"
        "- Speak as EXACTLY ONE of them per reply, choosing whoever would naturally "
        "respond. Alternate so neither dominates; if the advisor addresses one by "
        "name, that person answers.\n"
        "- Wrap the primary's spoken words in <primary>...</primary> and the spouse's "
        "in <spouse>...</spouse>. These tags are case-sensitive and pick the voice — "
        "always include exactly one pair per reply, with no text outside the tags.\n"
        "- Keep replies short and natural (1-3 sentences). You are prospective clients: "
        "polite, a little reserved, don't volunteer your full finances unprompted.\n"
        "- Never break character or mention you are an AI."
    )


def _voices_for(r: TrialStartRequest) -> list[dict]:
    primary = PRIMARY_FEMALE if r.primary_gender.lower() == "female" else PRIMARY_MALE
    spouse = SPOUSE_FEMALE if r.spouse_gender.lower() == "female" else SPOUSE_MALE
    return [
        {"label": "primary", "voice_id": primary},
        {"label": "spouse", "voice_id": spouse},
    ]


@router.post("/start", response_model=dict)
async def start_trial(
    payload: TrialStartRequest,
    _: User = Depends(require_advisor_or_admin),
):
    """Configure the trial agent for this couple persona and return a signed
    WebSocket URL for the browser SDK to connect to."""
    key = _convai_key()
    agent_id = (settings.ELEVENLABS_TRIAL_AGENT_ID or "").strip()
    if not agent_id:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="ELEVENLABS_TRIAL_AGENT_ID not set",
        )

    voices = _voices_for(payload)
    patch_body = {
        "conversation_config": {
            "agent": {
                "language": "en",
                "prompt": {
                    "prompt": _build_couple_prompt(payload),
                    "llm": "claude-3-7-sonnet",
                },
            },
            "tts": {
                "voice_id": voices[0]["voice_id"],
                "supported_voices": voices,
            },
        }
    }
    headers = {"xi-api-key": key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=15.0) as client:
        # 1) Update the agent's prompt + voices for this persona.
        patch = await client.patch(
            f"{CONVAI_BASE}/agents/{agent_id}", headers=headers, json=patch_body
        )
        if patch.status_code not in (200, 201):
            logger.warning("agent patch failed %d: %s", patch.status_code, patch.text[:300])
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to configure agent: {patch.status_code} {patch.text[:200]}",
            )
        # 2) Mint a short-lived signed URL so the agent stays private (the
        #    browser authenticates through this rather than a public id).
        signed = await client.get(
            f"{CONVAI_BASE}/conversation/get-signed-url",
            headers={"xi-api-key": key},
            params={"agent_id": agent_id},
        )
        if signed.status_code != 200:
            logger.warning("signed-url failed %d: %s", signed.status_code, signed.text[:300])
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to get signed URL: {signed.status_code} {signed.text[:200]}",
            )
        signed_url = signed.json().get("signed_url")

    return {
        "signed_url": signed_url,
        "primary_name": payload.primary_name,
        "spouse_name": payload.spouse_name,
        "primary_voice": voices[0]["voice_id"],
        "spouse_voice": voices[1]["voice_id"],
    }
