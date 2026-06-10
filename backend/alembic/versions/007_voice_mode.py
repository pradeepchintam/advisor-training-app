"""Add voice_mode to training_sessions.

Selects the live-voice engine for a session. "standard" (default) is the
existing STT->Claude->ElevenLabs cascade; "nova_sonic" routes the session
through Amazon Nova Sonic native speech-to-speech (the /ws/nova endpoint).

Revision ID: 007
Revises: 006
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # server_default backfills existing rows to the cascade engine without a
    # separate UPDATE. The ORM default handles new inserts.
    op.add_column(
        "training_sessions",
        sa.Column(
            "voice_mode",
            sa.String(length=20),
            nullable=False,
            server_default="standard",
        ),
    )


def downgrade() -> None:
    op.drop_column("training_sessions", "voice_mode")
