"""Admin-uploaded PowerPoint decks, version-controlled. Advisors fetch the active
version's slide images during a live session.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_admin, require_advisor_or_admin
from app.database import get_db
from app.models import Presentation, User
from app.schemas import PresentationPublic
from app.services.pptx_service import (
    convert_and_store,
    delete_presentation_files,
    get_slide_bytes,
)

router = APIRouter()


@router.get("/active", response_model=PresentationPublic)
async def get_active_presentation(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_advisor_or_admin),
):
    """Advisors call this at session start to know how many slides + the active deck id."""
    result = await db.execute(select(Presentation).where(Presentation.is_active == True))
    p = result.scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active presentation")
    return PresentationPublic.model_validate(p)


@router.get("", response_model=list[PresentationPublic])
async def list_presentations(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(Presentation).order_by(Presentation.version.desc()))
    return [PresentationPublic.model_validate(p) for p in result.scalars().all()]


@router.post("", response_model=PresentationPublic, status_code=status.HTTP_201_CREATED)
async def upload_presentation(
    title: str = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Upload a .pptx. Bumps version, marks new version active, deactivates older ones."""
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .pptx files are supported",
        )
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:  # 50 MB cap
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File too large (max 50 MB)")

    # Next version number
    latest = await db.execute(select(Presentation).order_by(Presentation.version.desc()))
    latest_p = latest.scalars().first()
    next_version = (latest_p.version + 1) if latest_p else 1

    presentation_id = str(uuid.uuid4())
    try:
        slides_dir, slide_count = await convert_and_store(content, presentation_id, file.filename)
    except Exception as e:  # noqa: BLE001 — surface conversion failures verbatim
        # Clean up partial files
        delete_presentation_files(presentation_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"PPTX conversion failed: {e}",
        )

    if slide_count == 0:
        delete_presentation_files(presentation_id)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PPTX has no slides")

    # Deactivate previous active
    active_q = await db.execute(select(Presentation).where(Presentation.is_active == True))
    for p in active_q.scalars().all():
        p.is_active = False

    new_p = Presentation(
        id=presentation_id,
        version=next_version,
        title=title,
        pptx_path=str(slides_dir / file.filename),
        slides_dir=str(slides_dir),
        slide_count=slide_count,
        is_active=True,
        uploaded_by=current_user.id,
        created_at=datetime.now(timezone.utc),
    )
    db.add(new_p)
    await db.flush()
    await db.refresh(new_p)
    return PresentationPublic.model_validate(new_p)


@router.post("/{presentation_id}/activate", response_model=PresentationPublic)
async def activate_presentation(
    presentation_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(Presentation).where(Presentation.id == presentation_id))
    target = result.scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation not found")

    active_q = await db.execute(select(Presentation).where(Presentation.is_active == True))
    for p in active_q.scalars().all():
        p.is_active = False
    target.is_active = True
    await db.flush()
    await db.refresh(target)
    return PresentationPublic.model_validate(target)


@router.delete("/{presentation_id}", response_model=dict)
async def delete_presentation(
    presentation_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(Presentation).where(Presentation.id == presentation_id))
    target = result.scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation not found")
    if target.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the active presentation. Activate another version first.",
        )
    delete_presentation_files(presentation_id)
    await db.delete(target)
    return {"message": "Deleted", "id": presentation_id}


@router.get("/{presentation_id}/slides/{slide_number}")
async def get_slide_image(
    presentation_id: str,
    slide_number: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(select(Presentation).where(Presentation.id == presentation_id))
    p = result.scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation not found")
    if slide_number < 1 or slide_number > p.slide_count:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Slide {slide_number} out of range (1..{p.slide_count})",
        )
    data = get_slide_bytes(presentation_id, slide_number)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Slide file missing on disk")
    return Response(content=data, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})
