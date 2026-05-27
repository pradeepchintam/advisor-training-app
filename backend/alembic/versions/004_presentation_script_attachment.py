"""Attach a PDF script to a presentation; record presentation_id on sessions

Revision ID: 004
Revises: 003
Create Date: 2026-05-26 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Script attachment on presentations
    op.add_column("presentations", sa.Column("script_pdf_path", sa.String(512), nullable=True))
    op.add_column("presentations", sa.Column("script_filename", sa.String(255), nullable=True))
    op.add_column("presentations", sa.Column("script_text", sa.Text(), nullable=True))

    # Record which deck a session ran against
    op.add_column(
        "training_sessions",
        sa.Column("presentation_id", sa.String(36), nullable=True),
    )
    op.create_foreign_key(
        "fk_training_sessions_presentation_id",
        "training_sessions",
        "presentations",
        ["presentation_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_training_sessions_presentation_id",
        "training_sessions",
        ["presentation_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_training_sessions_presentation_id", table_name="training_sessions")
    op.drop_constraint(
        "fk_training_sessions_presentation_id",
        "training_sessions",
        type_="foreignkey",
    )
    op.drop_column("training_sessions", "presentation_id")

    op.drop_column("presentations", "script_text")
    op.drop_column("presentations", "script_filename")
    op.drop_column("presentations", "script_pdf_path")
