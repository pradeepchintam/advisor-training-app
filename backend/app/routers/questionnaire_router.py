import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.database import get_db
from app.models import Questionnaire, User
from app.schemas import QuestionnairePublic

router = APIRouter()


@router.get("", response_model=QuestionnairePublic)
async def get_active_questionnaire(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Questionnaire).where(Questionnaire.is_active == True)
    )
    questionnaire = result.scalar_one_or_none()
    if questionnaire is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active questionnaire found",
        )
    return QuestionnairePublic.model_validate(questionnaire)


@router.put("", response_model=QuestionnairePublic)
async def update_questionnaire(
    content: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    # Get current version number
    result = await db.execute(
        select(Questionnaire).order_by(Questionnaire.version.desc())
    )
    latest = result.scalars().first()
    next_version = (latest.version + 1) if latest else 1

    # Deactivate all existing questionnaires
    active_result = await db.execute(
        select(Questionnaire).where(Questionnaire.is_active == True)
    )
    active_questionnaires = active_result.scalars().all()
    for q in active_questionnaires:
        q.is_active = False

    # Create new version
    new_questionnaire = Questionnaire(
        id=str(uuid.uuid4()),
        version=next_version,
        content=content,
        created_by=current_user.id,
        created_at=datetime.now(timezone.utc),
        is_active=True,
    )
    db.add(new_questionnaire)
    await db.flush()
    await db.refresh(new_questionnaire)

    return QuestionnairePublic.model_validate(new_questionnaire)


@router.get("/versions", response_model=list[QuestionnairePublic])
async def list_questionnaire_versions(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(
        select(Questionnaire).order_by(Questionnaire.version.desc())
    )
    questionnaires = result.scalars().all()
    return [QuestionnairePublic.model_validate(q) for q in questionnaires]
