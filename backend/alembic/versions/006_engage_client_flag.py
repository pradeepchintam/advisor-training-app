"""Add engage_client flag to training_sessions.

When False (default), the simulated client stays silent and the session is
a one-sided deck-walkthrough practice for the advisor. When True, the
client engages interactively (the original behavior).

Revision ID: 006
Revises: 005
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # server_default="0" so existing rows backfill to False (no client talk)
    # without a separate UPDATE. The ORM default handles new inserts.
    op.add_column(
        "training_sessions",
        sa.Column(
            "engage_client",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("training_sessions", "engage_client")
