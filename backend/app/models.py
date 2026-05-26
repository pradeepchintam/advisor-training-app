import uuid
from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="advisor")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    sessions: Mapped[list["TrainingSession"]] = relationship(
        "TrainingSession", back_populates="advisor", lazy="selectin"
    )


class TrainingSession(Base):
    __tablename__ = "training_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    advisor_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    persona: Mapped[dict] = mapped_column(JSON, nullable=False)
    client_name: Mapped[str] = mapped_column(String(255), nullable=False)
    client_image_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="active")
    conversation: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    slide_events: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    recording_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    analysis: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Provenance — "assigned" means an admin queued this session for the advisor;
    # "self_initiated" means the advisor started it themselves.
    source: Mapped[str] = mapped_column(
        String(32), nullable=False, default="self_initiated", index=True
    )
    assignment_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("session_assignments.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    advisor: Mapped["User"] = relationship("User", back_populates="sessions")
    assignment: Mapped["SessionAssignment | None"] = relationship(
        "SessionAssignment", back_populates="sessions", foreign_keys=[assignment_id]
    )


class SessionProfile(Base):
    """Reusable persona template authored by an admin and assigned to advisors."""
    __tablename__ = "session_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    persona: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    assignments: Mapped[list["SessionAssignment"]] = relationship(
        "SessionAssignment", back_populates="profile", lazy="selectin"
    )


class SessionAssignment(Base):
    """An admin's instruction to a specific advisor to run a session against a profile."""
    __tablename__ = "session_assignments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    profile_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("session_profiles.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    advisor_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    assigned_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    assigned_date: Mapped[date] = mapped_column(Date, nullable=False)
    target_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # pending | in_progress | completed | cancelled
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    profile: Mapped["SessionProfile"] = relationship(
        "SessionProfile", back_populates="assignments", lazy="joined"
    )
    sessions: Mapped[list["TrainingSession"]] = relationship(
        "TrainingSession", back_populates="assignment", foreign_keys=[TrainingSession.assignment_id]
    )


class Questionnaire(Base):
    __tablename__ = "questionnaire"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    content: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Presentation(Base):
    """Admin-uploaded PowerPoint deck. Version-controlled — every upload bumps version."""
    __tablename__ = "presentations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    pptx_path: Mapped[str] = mapped_column(String(512), nullable=False)
    slides_dir: Mapped[str] = mapped_column(String(512), nullable=False)  # dir containing slide-N.png
    slide_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    uploaded_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )


class TrainingScript(Base):
    """Admin-authored markdown script used to grade advisor adherence at session end."""
    __tablename__ = "training_scripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(String, nullable=False)  # markdown
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    uploaded_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
