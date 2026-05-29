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
from app.services.deck_slots import ALL_SLOTS, SLOT_FIRST
from app.services.pptx_service import (
    convert_and_store,
    delete_presentation_files,
    delete_script_pdf,
    get_script_pdf_bytes,
    get_slide_bytes,
    store_script_pdf,
)

router = APIRouter()

# Max size for an attached script PDF.
_MAX_SCRIPT_BYTES = 25 * 1024 * 1024  # 25 MB


def _validate_slot(slot: str) -> str:
    if slot not in ALL_SLOTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid slot '{slot}'. Must be one of: {', '.join(ALL_SLOTS)}",
        )
    return slot


def _validate_pdf(upload: UploadFile) -> None:
    if not upload.filename or not upload.filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Script must be a .pdf file",
        )


@router.get("/active", response_model=PresentationPublic)
async def get_active_presentation(
    slot: str = SLOT_FIRST,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_advisor_or_admin),
):
    """Active deck for a given slot (defaults to the first-appointment slot)."""
    _validate_slot(slot)
    result = await db.execute(
        select(Presentation).where(
            Presentation.is_active == True, Presentation.slot == slot  # noqa: E712
        )
    )
    p = result.scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active presentation")
    return PresentationPublic.from_model(p)


@router.get("", response_model=list[PresentationPublic])
async def list_presentations(
    slot: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    q = select(Presentation).order_by(Presentation.version.desc())
    if slot:
        _validate_slot(slot)
        q = q.where(Presentation.slot == slot)
    result = await db.execute(q)
    return [PresentationPublic.from_model(p) for p in result.scalars().all()]


@router.post("", response_model=PresentationPublic, status_code=status.HTTP_201_CREATED)
async def upload_presentation(
    title: str = Form(...),
    slot: str = Form(SLOT_FIRST),
    files: list[UploadFile] = File(...),
    script: UploadFile | None = File(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Upload one or more .pptx files (merged in order into a single deck)
    with an optional attached .pdf script. Bumps version per slot, marks the
    new version active, deactivates older ones in the SAME slot."""
    _validate_slot(slot)
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one .pptx file is required",
        )

    # Read + validate every uploaded file.
    contents: list[tuple[bytes, str]] = []
    total_bytes = 0
    for f in files:
        if not f.filename or not f.filename.lower().endswith(".pptx"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Only .pptx files are supported (got {f.filename!r})",
            )
        data = await f.read()
        total_bytes += len(data)
        contents.append((data, f.filename))

    if total_bytes > 150 * 1024 * 1024:  # 150 MB combined cap
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Total upload too large ({total_bytes / 1024 / 1024:.1f} MB; max 150 MB combined)",
        )
    # Keep the variable name `content` for downstream readability in error messages
    content = contents

    # Optional script PDF — read + validate up front so we fail before conversion.
    script_bytes: bytes | None = None
    script_orig_name: str | None = None
    if script is not None and script.filename:
        _validate_pdf(script)
        script_bytes = await script.read()
        if len(script_bytes) > _MAX_SCRIPT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Script PDF too large (max 25 MB)",
            )
        script_orig_name = script.filename

    # Next version number — versioned per slot.
    latest = await db.execute(
        select(Presentation).where(Presentation.slot == slot).order_by(Presentation.version.desc())
    )
    latest_p = latest.scalars().first()
    next_version = (latest_p.version + 1) if latest_p else 1

    presentation_id = str(uuid.uuid4())
    try:
        slides_dir, slide_count, primary_pptx = await convert_and_store(content, presentation_id)
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

    # Deactivate previous active deck IN THE SAME SLOT only.
    active_q = await db.execute(
        select(Presentation).where(
            Presentation.is_active == True, Presentation.slot == slot  # noqa: E712
        )
    )
    for p in active_q.scalars().all():
        p.is_active = False

    new_p = Presentation(
        id=presentation_id,
        version=next_version,
        title=title,
        slot=slot,
        pptx_path=str(primary_pptx),
        slides_dir=str(slides_dir),
        slide_count=slide_count,
        is_active=True,
        uploaded_by=current_user.id,
        created_at=datetime.now(timezone.utc),
    )

    # Attach the script PDF if one was supplied.
    if script_bytes is not None:
        stored_path, safe_name, text = store_script_pdf(
            presentation_id, script_bytes, script_orig_name or "script.pdf"
        )
        new_p.script_pdf_path = stored_path
        new_p.script_filename = safe_name
        new_p.script_text = text or None

    db.add(new_p)
    await db.flush()
    await db.refresh(new_p)
    return PresentationPublic.from_model(new_p)


@router.post("/{presentation_id}/script", response_model=PresentationPublic)
async def attach_script(
    presentation_id: str,
    script: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Attach or replace the PDF script for an existing presentation."""
    result = await db.execute(select(Presentation).where(Presentation.id == presentation_id))
    p = result.scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation not found")

    _validate_pdf(script)
    script_bytes = await script.read()
    if len(script_bytes) > _MAX_SCRIPT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Script PDF too large (max 25 MB)",
        )

    stored_path, safe_name, text = store_script_pdf(
        presentation_id, script_bytes, script.filename or "script.pdf"
    )
    p.script_pdf_path = stored_path
    p.script_filename = safe_name
    p.script_text = text or None
    await db.flush()
    await db.refresh(p)
    return PresentationPublic.from_model(p)


@router.delete("/{presentation_id}/script", response_model=PresentationPublic)
async def remove_script(
    presentation_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Detach the script from a presentation."""
    result = await db.execute(select(Presentation).where(Presentation.id == presentation_id))
    p = result.scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation not found")
    delete_script_pdf(presentation_id)
    p.script_pdf_path = None
    p.script_filename = None
    p.script_text = None
    await db.flush()
    await db.refresh(p)
    return PresentationPublic.from_model(p)


@router.get("/{presentation_id}/script")
async def download_script(
    presentation_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_advisor_or_admin),
):
    """Stream the attached script PDF (admin preview / advisor reference)."""
    result = await db.execute(select(Presentation).where(Presentation.id == presentation_id))
    p = result.scalar_one_or_none()
    if p is None or not p.script_pdf_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No script attached")
    data = get_script_pdf_bytes(presentation_id)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Script file missing on disk")
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{p.script_filename or "script.pdf"}"'},
    )


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

    # Only one active deck per slot — deactivate others in the target's slot.
    active_q = await db.execute(
        select(Presentation).where(
            Presentation.is_active == True, Presentation.slot == target.slot  # noqa: E712
        )
    )
    for p in active_q.scalars().all():
        p.is_active = False
    target.is_active = True
    await db.flush()
    await db.refresh(target)
    return PresentationPublic.from_model(target)


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
