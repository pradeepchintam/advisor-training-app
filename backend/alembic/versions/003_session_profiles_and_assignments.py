"""Add session_profiles + session_assignments; add source + assignment_id to training_sessions

Revision ID: 003
Revises: 002
Create Date: 2026-05-22 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # session_profiles — reusable persona templates owned by admins
    op.create_table(
        "session_profiles",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.String(1024), nullable=True),
        sa.Column("persona", sa.JSON(), nullable=False),
        sa.Column(
            "created_by",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_session_profiles_is_active", "session_profiles", ["is_active"])

    # session_assignments — admin -> advisor instructions with dates
    op.create_table(
        "session_assignments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "profile_id",
            sa.String(36),
            sa.ForeignKey("session_profiles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "advisor_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "assigned_by",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("assigned_date", sa.Date(), nullable=False),
        sa.Column("target_date", sa.Date(), nullable=False),
        sa.Column(
            "status",
            sa.String(32),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_session_assignments_profile_id", "session_assignments", ["profile_id"])
    op.create_index("ix_session_assignments_advisor_id", "session_assignments", ["advisor_id"])
    op.create_index("ix_session_assignments_target_date", "session_assignments", ["target_date"])
    op.create_index("ix_session_assignments_status", "session_assignments", ["status"])

    # training_sessions: track provenance + link back to the assignment (if any)
    op.add_column(
        "training_sessions",
        sa.Column(
            "source",
            sa.String(32),
            nullable=False,
            server_default="self_initiated",
        ),
    )
    op.create_index("ix_training_sessions_source", "training_sessions", ["source"])

    op.add_column(
        "training_sessions",
        sa.Column("assignment_id", sa.String(36), nullable=True),
    )
    op.create_foreign_key(
        "fk_training_sessions_assignment_id",
        "training_sessions",
        "session_assignments",
        ["assignment_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_training_sessions_assignment_id", "training_sessions", ["assignment_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_training_sessions_assignment_id", table_name="training_sessions")
    op.drop_constraint(
        "fk_training_sessions_assignment_id",
        "training_sessions",
        type_="foreignkey",
    )
    op.drop_column("training_sessions", "assignment_id")

    op.drop_index("ix_training_sessions_source", table_name="training_sessions")
    op.drop_column("training_sessions", "source")

    op.drop_index("ix_session_assignments_status", table_name="session_assignments")
    op.drop_index("ix_session_assignments_target_date", table_name="session_assignments")
    op.drop_index("ix_session_assignments_advisor_id", table_name="session_assignments")
    op.drop_index("ix_session_assignments_profile_id", table_name="session_assignments")
    op.drop_table("session_assignments")

    op.drop_index("ix_session_profiles_is_active", table_name="session_profiles")
    op.drop_table("session_profiles")
