"""POST /api/tts — synthesize speech via Polly. Returns audio/mpeg bytes."""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.auth import require_advisor_or_admin
from app.models import User
from app.services.tts_service import fetch_visemes, synthesize

router = APIRouter()


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000)
    gender: str | None = None      # "male" / "female"
    age_group: str | None = None   # "young_adult" / "middle_aged" / "senior" / "elderly"


@router.post("", response_class=Response)
async def tts(
    payload: TTSRequest,
    _: User = Depends(require_advisor_or_admin),
):
    try:
        audio = await synthesize(payload.text, payload.gender, payload.age_group)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/marks", response_model=dict)
async def tts_marks(
    payload: TTSRequest,
    _: User = Depends(require_advisor_or_admin),
):
    """Returns Polly speech marks (visemes + words) for the same `text` so the
    frontend can drive a viseme-aligned lip overlay on top of the client photo
    while the audio is playing."""
    try:
        marks = await fetch_visemes(payload.text, payload.gender, payload.age_group)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    return {"marks": marks}
