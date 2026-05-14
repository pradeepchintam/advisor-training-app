import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def create_tables() -> None:
    from app import models  # noqa: F401 – ensure models are registered

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def init_db() -> None:
    """Create tables and seed admin user + questionnaire if they don't exist."""
    await create_tables()

    async with AsyncSessionLocal() as session:
        from sqlalchemy import select

        from app.auth import get_password_hash
        from app.models import Questionnaire, User

        # Seed admin user
        result = await session.execute(
            select(User).where(User.email == settings.ADMIN_EMAIL)
        )
        admin = result.scalar_one_or_none()
        if admin is None:
            admin = User(
                id=str(uuid.uuid4()),
                email=settings.ADMIN_EMAIL,
                name="Admin",
                hashed_password=get_password_hash(settings.ADMIN_PASSWORD),
                role="admin",
                is_active=True,
                created_at=datetime.now(timezone.utc),
            )
            session.add(admin)
            await session.flush()

        # Seed questionnaire if none exists
        result = await session.execute(select(Questionnaire).where(Questionnaire.is_active == True))
        existing_q = result.scalar_one_or_none()
        if existing_q is None:
            import json
            import os

            questionnaire_path = os.path.join(
                os.path.dirname(os.path.dirname(__file__)), "data", "questionnaire.json"
            )
            if os.path.exists(questionnaire_path):
                with open(questionnaire_path, "r") as f:
                    content = json.load(f)
                questionnaire = Questionnaire(
                    id=str(uuid.uuid4()),
                    version=1,
                    content=content,
                    created_by=admin.id,
                    created_at=datetime.now(timezone.utc),
                    is_active=True,
                )
                session.add(questionnaire)

        await session.commit()
