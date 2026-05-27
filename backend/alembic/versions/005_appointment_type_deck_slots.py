"""Per-appointment deck slots + appointment_type on profiles and sessions

Revision ID: 005
Revises: 004
Create Date: 2026-05-26 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Deck slot on presentations. Existing decks default to the first-appointment
    # slot so they keep working as the fallback deck.
    op.add_column(
        "presentations",
        sa.Column("slot", sa.String(32), nullable=False, server_default="first"),
    )
    op.create_index("ix_presentations_slot", "presentations", ["slot"])

    # Appointment type on profiles
    op.add_column(
        "session_profiles",
        sa.Column("appointment_type", sa.String(16), nullable=True),
    )

    # Appointment type on sessions
    op.add_column(
        "training_sessions",
        sa.Column("appointment_type", sa.String(16), nullable=True),
    )
    op.create_index(
        "ix_training_sessions_appointment_type",
        "training_sessions",
        ["appointment_type"],
    )


def downgrade() -> None:
    op.drop_index("ix_training_sessions_appointment_type", table_name="training_sessions")
    op.drop_column("training_sessions", "appointment_type")
    op.drop_column("session_profiles", "appointment_type")
    op.drop_index("ix_presentations_slot", table_name="presentations")
    op.drop_column("presentations", "slot")
