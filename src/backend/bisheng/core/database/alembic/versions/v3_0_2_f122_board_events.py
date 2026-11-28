"""Add Web assistant runtime facts for company boards."""

import sqlalchemy as sa
from alembic import op

from bisheng.core.database.alembic_helpers.online import table_exists

revision = "f122_board_events"
down_revision = "f122_board_ledger"
branch_labels = None
depends_on = None


def upgrade():
    if table_exists("board_runtime_event"):
        return
    op.create_table(
        "board_runtime_event",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("tenant_id", sa.Integer, nullable=False),
        sa.Column("run_id", sa.String(32), nullable=False),
        sa.Column("user_id", sa.Integer, nullable=False),
        sa.Column("department_id", sa.Integer, nullable=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("asset_id", sa.String(128), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("occurred_at", sa.DateTime, nullable=False),
        sa.Column("active_seconds", sa.Float, nullable=True),
        sa.Column("terminal_message_id", sa.Integer, nullable=True),
    )
    op.create_index("ix_board_runtime_window", "board_runtime_event", ["tenant_id", "occurred_at", "kind"])
    op.create_index("ix_board_runtime_event_run_id", "board_runtime_event", ["run_id"])
    op.create_index("ix_board_runtime_event_terminal_message_id", "board_runtime_event", ["terminal_message_id"])


def downgrade():
    if table_exists("board_runtime_event"):
        op.drop_table("board_runtime_event")
