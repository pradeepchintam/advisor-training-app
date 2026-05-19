"""Add presentations + training_scripts tables, slide_events column

Revision ID: 002
Revises: 001
Create Date: 2026-05-16 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # slide_events column on training_sessions
    op.add_column(
        "training_sessions",
        sa.Column(
            "slide_events",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )

    # presentations
    op.create_table(
        "presentations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("pptx_path", sa.String(512), nullable=False),
        sa.Column("slides_dir", sa.String(512), nullable=False),
        sa.Column("slide_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "uploaded_by",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_presentations_is_active", "presentations", ["is_active"])

    # training_scripts
    op.create_table(
        "training_scripts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "uploaded_by",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_training_scripts_is_active", "training_scripts", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_training_scripts_is_active", table_name="training_scripts")
    op.drop_table("training_scripts")
    op.drop_index("ix_presentations_is_active", table_name="presentations")
    op.drop_table("presentations")
    op.drop_column("training_sessions", "slide_events")
