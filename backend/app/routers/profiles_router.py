"""CRUD for reusable session profiles (persona templates) — admin only."""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_admin
from app.database import get_db
from app.models import SessionProfile, User
from app.schemas import (
    ClientPersona,
    SessionProfileCreate,
    SessionProfilePublic,
    SessionProfileUpdate,
)

router = APIRouter()


def _to_public(p: SessionProfile) -> SessionProfilePublic:
    return SessionProfilePublic(
        id=p.id,
        name=p.name,
        description=p.description,
        persona=ClientPersona(**p.persona),
        created_by=p.created_by,
        is_active=p.is_active,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


@router.get("", response_model=list[SessionProfilePublic])
async def list_profiles(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    q = select(SessionProfile).order_by(SessionProfile.created_at.desc())
    if not include_inactive:
        q = q.where(SessionProfile.is_active == True)  # noqa: E712
    result = await db.execute(q)
    return [_to_public(p) for p in result.scalars().all()]


@router.post("", response_model=SessionProfilePublic, status_code=status.HTTP_201_CREATED)
async def create_profile(
    payload: SessionProfileCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    profile = SessionProfile(
        id=str(uuid.uuid4()),
        name=payload.name.strip(),
        description=(payload.description or None),
        persona=payload.persona.model_dump(),
        created_by=current_user.id,
        is_active=True,
    )
    db.add(profile)
    await db.flush()
    await db.refresh(profile)
    return _to_public(profile)


@router.get("/{profile_id}", response_model=SessionProfilePublic)
async def get_profile(
    profile_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(SessionProfile).where(SessionProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found")
    return _to_public(profile)


@router.patch("/{profile_id}", response_model=SessionProfilePublic)
async def update_profile(
    profile_id: str,
    payload: SessionProfileUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(SessionProfile).where(SessionProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found")

    if payload.name is not None:
        profile.name = payload.name.strip()
    if payload.description is not None:
        profile.description = payload.description or None
    if payload.persona is not None:
        profile.persona = payload.persona.model_dump()
    if payload.is_active is not None:
        profile.is_active = payload.is_active

    profile.updated_at = datetime.now(timezone.utc)
    await db.flush()
    await db.refresh(profile)
    return _to_public(profile)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_profile(
    profile_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Soft-delete: marks the profile inactive so it can no longer be assigned,
    but existing assignments and sessions still resolve their persona."""
    result = await db.execute(select(SessionProfile).where(SessionProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found")
    profile.is_active = False
    profile.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return None
