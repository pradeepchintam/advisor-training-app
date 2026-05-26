"""Admin assigns SessionProfiles to advisors; advisors list their own."""
import uuid
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_admin, require_advisor, require_advisor_or_admin
from app.database import get_db
from app.models import SessionAssignment, SessionProfile, TrainingSession, User
from app.schemas import (
    AssignmentCreate,
    AssignmentPublic,
    AssignmentUpdate,
    ClientPersona,
    MyAssignmentsResponse,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _build_public(
    a: SessionAssignment,
    db: AsyncSession,
    *,
    advisor_map: dict[str, str] | None = None,
    assigner_map: dict[str, str] | None = None,
) -> AssignmentPublic:
    """Hydrate an assignment row into its AssignmentPublic shape, including
    the latest linked session id (if the advisor has started one)."""

    # Resolve persona either from the live profile or the legacy snapshot.
    profile = a.profile
    if profile is None:
        result = await db.execute(
            select(SessionProfile).where(SessionProfile.id == a.profile_id)
        )
        profile = result.scalar_one_or_none()

    if profile is None:
        # Profile was hard-deleted somehow; surface a stub so the UI doesn't crash.
        persona = ClientPersona(
            name="(unknown)", age=0, age_group="middle_aged", gender="male",
            marital_status="single", has_children=False, num_children=0,
            employment_types=[], occupation="", financial_situation="",
            estimated_net_worth="", estimated_income="", has_debt="",
            risk_tolerance="", investment_experience="", primary_concerns=[],
            personality_type="", communication_style="", previous_advisor=False,
            urgency="", referral_source="", backstory="",
        )
        profile_name = "(deleted profile)"
        profile_description: str | None = None
    else:
        persona = ClientPersona(**profile.persona)
        profile_name = profile.name
        profile_description = profile.description

    # Find the most recent session linked to this assignment (if any).
    sess_result = await db.execute(
        select(TrainingSession)
        .where(TrainingSession.assignment_id == a.id)
        .order_by(TrainingSession.started_at.desc())
    )
    latest_session = sess_result.scalars().first()

    advisor_name = (advisor_map or {}).get(a.advisor_id)
    assigner_name = (assigner_map or {}).get(a.assigned_by) if a.assigned_by else None

    return AssignmentPublic(
        id=a.id,
        profile_id=a.profile_id,
        profile_name=profile_name,
        profile_description=profile_description,
        persona=persona,
        advisor_id=a.advisor_id,
        advisor_name=advisor_name,
        assigned_by=a.assigned_by,
        assigned_by_name=assigner_name,
        assigned_date=a.assigned_date,
        target_date=a.target_date,
        status=a.status,
        created_at=a.created_at,
        session_id=latest_session.id if latest_session else None,
    )


async def _user_name_map(db: AsyncSession, user_ids: list[str]) -> dict[str, str]:
    user_ids = [u for u in user_ids if u]
    if not user_ids:
        return {}
    result = await db.execute(select(User).where(User.id.in_(user_ids)))
    return {u.id: u.name for u in result.scalars().all()}


# ---------------------------------------------------------------------------
# Admin: create assignments (fanout)
# ---------------------------------------------------------------------------

@router.post("", response_model=list[AssignmentPublic], status_code=status.HTTP_201_CREATED)
async def create_assignments(
    payload: AssignmentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if payload.target_date < payload.assigned_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target_date cannot be before assigned_date",
        )

    # Validate profile
    prof_result = await db.execute(
        select(SessionProfile).where(SessionProfile.id == payload.profile_id)
    )
    profile = prof_result.scalar_one_or_none()
    if profile is None or not profile.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Profile not found or inactive",
        )

    # Validate advisors — must exist, be active, and have role 'advisor'
    advisors_result = await db.execute(
        select(User).where(User.id.in_(payload.advisor_ids))
    )
    advisors = {u.id: u for u in advisors_result.scalars().all()}
    missing = [aid for aid in payload.advisor_ids if aid not in advisors]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown advisor id(s): {', '.join(missing)}",
        )
    bad_role = [aid for aid, u in advisors.items() if u.role != "advisor" or not u.is_active]
    if bad_role:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Not an active advisor: {', '.join(bad_role)}",
        )

    created: list[SessionAssignment] = []
    for advisor_id in payload.advisor_ids:
        a = SessionAssignment(
            id=str(uuid.uuid4()),
            profile_id=payload.profile_id,
            advisor_id=advisor_id,
            assigned_by=current_user.id,
            assigned_date=payload.assigned_date,
            target_date=payload.target_date,
            status="pending",
        )
        db.add(a)
        created.append(a)

    await db.flush()
    for a in created:
        await db.refresh(a)

    advisor_map = await _user_name_map(db, payload.advisor_ids)
    assigner_map = await _user_name_map(db, [current_user.id])

    return [
        await _build_public(a, db, advisor_map=advisor_map, assigner_map=assigner_map)
        for a in created
    ]


# ---------------------------------------------------------------------------
# Admin: list / filter
# ---------------------------------------------------------------------------

@router.get("", response_model=list[AssignmentPublic])
async def list_assignments(
    advisor_id: str | None = None,
    status_filter: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    q = select(SessionAssignment).order_by(SessionAssignment.target_date.desc())
    if advisor_id:
        q = q.where(SessionAssignment.advisor_id == advisor_id)
    if status_filter:
        q = q.where(SessionAssignment.status == status_filter)
    result = await db.execute(q)
    assignments = result.scalars().all()

    advisor_map = await _user_name_map(db, [a.advisor_id for a in assignments])
    assigner_map = await _user_name_map(db, [a.assigned_by for a in assignments])

    return [
        await _build_public(a, db, advisor_map=advisor_map, assigner_map=assigner_map)
        for a in assignments
    ]


# ---------------------------------------------------------------------------
# Advisor: list-mine (grouped today/upcoming/past)
# ---------------------------------------------------------------------------

@router.get("/me", response_model=MyAssignmentsResponse)
async def list_my_assignments(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    # Admins can pass through this endpoint but the response will be empty for them
    # unless they happen to also be assigned (unlikely). We return their own slice.
    q = (
        select(SessionAssignment)
        .where(SessionAssignment.advisor_id == current_user.id)
        .order_by(SessionAssignment.target_date.asc())
    )
    result = await db.execute(q)
    assignments = result.scalars().all()

    advisor_map = await _user_name_map(db, [current_user.id])
    assigner_map = await _user_name_map(
        db, [a.assigned_by for a in assignments if a.assigned_by]
    )

    today = date.today()
    today_list: list[AssignmentPublic] = []
    upcoming_list: list[AssignmentPublic] = []
    past_list: list[AssignmentPublic] = []

    for a in assignments:
        pub = await _build_public(a, db, advisor_map=advisor_map, assigner_map=assigner_map)
        if a.status in ("completed", "cancelled"):
            past_list.append(pub)
        elif a.target_date <= today:
            # Due today or overdue but still actionable
            today_list.append(pub)
        else:
            upcoming_list.append(pub)

    return MyAssignmentsResponse(today=today_list, upcoming=upcoming_list, past=past_list)


# ---------------------------------------------------------------------------
# Admin: update / cancel
# ---------------------------------------------------------------------------

@router.patch("/{assignment_id}", response_model=AssignmentPublic)
async def update_assignment(
    assignment_id: str,
    payload: AssignmentUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(
        select(SessionAssignment).where(SessionAssignment.id == assignment_id)
    )
    a = result.scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")

    if payload.assigned_date is not None:
        a.assigned_date = payload.assigned_date
    if payload.target_date is not None:
        a.target_date = payload.target_date
    if payload.status is not None:
        if payload.status not in ("pending", "in_progress", "completed", "cancelled"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid status",
            )
        a.status = payload.status

    if a.target_date < a.assigned_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target_date cannot be before assigned_date",
        )

    await db.flush()
    await db.refresh(a)

    advisor_map = await _user_name_map(db, [a.advisor_id])
    assigner_map = await _user_name_map(db, [a.assigned_by]) if a.assigned_by else {}
    return await _build_public(a, db, advisor_map=advisor_map, assigner_map=assigner_map)


@router.delete("/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_assignment(
    assignment_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(
        select(SessionAssignment).where(SessionAssignment.id == assignment_id)
    )
    a = result.scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")
    a.status = "cancelled"
    await db.flush()
    return None
