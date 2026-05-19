"""POST /api/tts — synthesize speech via Polly. Returns audio/mpeg bytes."""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.auth import require_advisor_or_admin
from app.models import User
from app.services.tts_service import synthesize

router = APIRouter()


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000)
    gender: str | None = None  # "male" / "female" — drives voice selection


@router.post("", response_class=Response)
async def tts(
    payload: TTSRequest,
    _: User = Depends(require_advisor_or_admin),
):
    try:
        audio = await synthesize(payload.text, payload.gender)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )
