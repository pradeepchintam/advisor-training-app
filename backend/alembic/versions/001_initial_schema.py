"""Initial schema: users, training_sessions, questionnaire

Revision ID: 001
Revises:
Create Date: 2024-01-01 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -----------------------------------------------------------------------
    # users
    # -----------------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("role", sa.String(50), nullable=False, server_default="advisor"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)

    # -----------------------------------------------------------------------
    # training_sessions
    # -----------------------------------------------------------------------
    op.create_table(
        "training_sessions",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("advisor_id", sa.String(36), nullable=False),
        sa.Column("persona", sa.JSON(), nullable=False),
        sa.Column("client_name", sa.String(255), nullable=False),
        sa.Column("client_image_url", sa.String(512), nullable=True),
        sa.Column("status", sa.String(50), nullable=False, server_default="active"),
        sa.Column("conversation", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("recording_path", sa.String(512), nullable=True),
        sa.Column("analysis", sa.JSON(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["advisor_id"], ["users.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_training_sessions_advisor_id"),
        "training_sessions",
        ["advisor_id"],
        unique=False,
    )

    # -----------------------------------------------------------------------
    # questionnaire
    # -----------------------------------------------------------------------
    op.create_table(
        "questionnaire",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("questionnaire")
    op.drop_index(op.f("ix_training_sessions_advisor_id"), table_name="training_sessions")
    op.drop_table("training_sessions")
    op.drop_index(op.f("ix_users_email"), table_name="users")
    op.drop_table("users")
