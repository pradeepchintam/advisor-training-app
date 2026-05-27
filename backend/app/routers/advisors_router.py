import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_password_hash, require_admin
from app.database import get_db
from app.models import TrainingSession, User
from app.schemas import AdvisorWithStats, UserCreate, UserPublic, UserUpdate, UserWithSessionCount

router = APIRouter()


@router.get("", response_model=list[AdvisorWithStats])
async def list_advisors(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User))
    users = result.scalars().all()

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    output = []
    for user in users:
        # Total sessions
        total_result = await db.execute(
            select(func.count(TrainingSession.id)).where(TrainingSession.advisor_id == user.id)
        )
        total = total_result.scalar_one()

        # Sessions this month
        month_result = await db.execute(
            select(func.count(TrainingSession.id))
            .where(TrainingSession.advisor_id == user.id)
            .where(TrainingSession.started_at >= month_start)
        )
        month_count = month_result.scalar_one()

        # Avg score across completed sessions
        scored_result = await db.execute(
            select(TrainingSession.analysis)
            .where(TrainingSession.advisor_id == user.id)
            .where(TrainingSession.status == "completed")
        )
        analyses = scored_result.scalars().all()
        scores = [
            a["overall_score"]
            for a in analyses
            if a and isinstance(a.get("overall_score"), (int, float))
        ]
        avg = sum(scores) / len(scores) if scores else None

        stats = AdvisorWithStats.model_validate(user)
        stats.total_sessions = total
        stats.sessions_this_month = month_count
        stats.avg_score = avg
        output.append(stats)

    return output


@router.post("", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def create_advisor(
    payload: UserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    # Check duplicate email
    result = await db.execute(select(User).where(User.email == payload.email))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    user = User(
        id=str(uuid.uuid4()),
        email=payload.email,
        name=payload.name,
        hashed_password=get_password_hash(payload.password),
        role=payload.role,
        is_active=True,
        created_at=datetime.now(timezone.utc),
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)

    # Auto-assign the onboarding curriculum to newly created advisors (not admins).
    # Wrapped so a curriculum failure never blocks advisor creation.
    if user.role == "advisor":
        try:
            from app.services.curriculum_service import assign_curriculum_to_advisor
            await assign_curriculum_to_advisor(db, user.id, assigned_by=current_user.id)
        except Exception as e:  # noqa: BLE001
            import logging
            logging.getLogger("trajan.curriculum").warning(
                "Failed to auto-assign curriculum to advisor %s: %s", user.id, e
            )

    return UserPublic.model_validate(user)


@router.post("/curriculum/backfill", response_model=dict)
async def backfill_curriculum(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Ensure the curriculum profiles exist and assign the 60-assignment program
    to every active advisor that doesn't already have it. Idempotent."""
    from app.services.curriculum_service import (
        assign_curriculum_to_advisor,
        ensure_curriculum_profiles,
    )

    profiles_created = await ensure_curriculum_profiles(db, created_by=current_user.id)

    advisors_q = await db.execute(
        select(User).where(User.role == "advisor", User.is_active == True)  # noqa: E712
    )
    advisors = advisors_q.scalars().all()

    results = []
    for adv in advisors:
        created = await assign_curriculum_to_advisor(db, adv.id, assigned_by=current_user.id)
        results.append({"advisor_id": adv.id, "name": adv.name, "assignments_created": created})

    return {
        "profiles_created": profiles_created,
        "advisors_processed": len(advisors),
        "details": results,
    }


@router.get("/{advisor_id}", response_model=dict)
async def get_advisor(
    advisor_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == advisor_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Advisor not found")

    sessions_result = await db.execute(
        select(TrainingSession)
        .where(TrainingSession.advisor_id == advisor_id)
        .order_by(TrainingSession.started_at.desc())
        .limit(10)
    )
    sessions = sessions_result.scalars().all()

    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at,
        "recent_sessions": [
            {
                "id": s.id,
                "client_name": s.client_name,
                "status": s.status,
                "started_at": s.started_at,
                "ended_at": s.ended_at,
                "overall_score": s.analysis.get("overall_score") if s.analysis else None,
            }
            for s in sessions
        ],
    }


@router.put("/{advisor_id}", response_model=UserPublic)
async def update_advisor(
    advisor_id: str,
    payload: UserUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == advisor_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Advisor not found")

    if payload.name is not None:
        user.name = payload.name
    if payload.email is not None:
        # Check for duplicate
        dup = await db.execute(
            select(User).where(User.email == payload.email, User.id != advisor_id)
        )
        if dup.scalar_one_or_none():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use")
        user.email = payload.email
    if payload.is_active is not None:
        user.is_active = payload.is_active
    if payload.password is not None:
        if len(payload.password) < 8:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Password must be at least 8 characters",
            )
        user.hashed_password = get_password_hash(payload.password)

    await db.flush()
    await db.refresh(user)
    return UserPublic.model_validate(user)


@router.delete("/{advisor_id}", response_model=dict)
async def deactivate_advisor(
    advisor_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == advisor_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Advisor not found")

    user.is_active = False
    await db.flush()
    return {"message": "Advisor deactivated successfully", "id": advisor_id}
