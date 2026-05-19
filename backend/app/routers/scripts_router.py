"""Admin-authored training scripts (markdown). Same versioning model as Questionnaire."""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_admin, require_advisor_or_admin
from app.database import get_db
from app.models import TrainingScript, User
from app.schemas import ScriptCreate, ScriptPublic

router = APIRouter()


@router.get("/active", response_model=ScriptPublic)
async def get_active_script(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(select(TrainingScript).where(TrainingScript.is_active == True))
    s = result.scalar_one_or_none()
    if s is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active training script")
    return ScriptPublic.model_validate(s)


@router.get("", response_model=list[ScriptPublic])
async def list_scripts(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(TrainingScript).order_by(TrainingScript.version.desc()))
    return [ScriptPublic.model_validate(s) for s in result.scalars().all()]


@router.post("", response_model=ScriptPublic, status_code=status.HTTP_201_CREATED)
async def create_script(
    payload: ScriptCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if not payload.content.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="content is required")

    latest = await db.execute(select(TrainingScript).order_by(TrainingScript.version.desc()))
    latest_s = latest.scalars().first()
    next_version = (latest_s.version + 1) if latest_s else 1

    active_q = await db.execute(select(TrainingScript).where(TrainingScript.is_active == True))
    for s in active_q.scalars().all():
        s.is_active = False

    new_s = TrainingScript(
        id=str(uuid.uuid4()),
        version=next_version,
        title=payload.title or f"Version {next_version}",
        content=payload.content,
        is_active=True,
        uploaded_by=current_user.id,
        created_at=datetime.now(timezone.utc),
    )
    db.add(new_s)
    await db.flush()
    await db.refresh(new_s)
    return ScriptPublic.model_validate(new_s)


@router.post("/{script_id}/activate", response_model=ScriptPublic)
async def activate_script(
    script_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(TrainingScript).where(TrainingScript.id == script_id))
    target = result.scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Script not found")
    active_q = await db.execute(select(TrainingScript).where(TrainingScript.is_active == True))
    for s in active_q.scalars().all():
        s.is_active = False
    target.is_active = True
    await db.flush()
    await db.refresh(target)
    return ScriptPublic.model_validate(target)


@router.delete("/{script_id}", response_model=dict)
async def delete_script(
    script_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(TrainingScript).where(TrainingScript.id == script_id))
    target = result.scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Script not found")
    if target.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the active script. Activate another version first.",
        )
    await db.delete(target)
    return {"message": "Deleted", "id": script_id}
