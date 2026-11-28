"""Preserve Web feedback history and a single resolution per observed task."""

import sqlalchemy as sa
from alembic import op

from bisheng.core.database.alembic_helpers.online import table_exists

revision = "f122_board_feedback"
down_revision = "f122_board_events"
branch_labels = None
depends_on = None


def upgrade():
    if not table_exists("board_web_rating"):
        op.create_table(
            "board_web_rating",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("tenant_id", sa.Integer(), nullable=False),
            sa.Column("message_id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("rating", sa.Integer(), nullable=False),
            sa.Column("rated_at", sa.DateTime(), nullable=False),
        )
        op.create_index("ix_board_rating_lookup", "board_web_rating", ["tenant_id", "message_id", "rated_at"])
    if not table_exists("board_issue_resolution"):
        op.create_table(
            "board_issue_resolution",
            sa.Column("tenant_id", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("run_id", sa.String(32), primary_key=True),
            sa.Column("operator_id", sa.Integer(), nullable=False),
            sa.Column("resolved_at", sa.DateTime(), nullable=False),
            sa.Column("measure", sa.String(500), nullable=False),
        )


def downgrade():
    for name in ("board_issue_resolution", "board_web_rating"):
        if table_exists(name):
            op.drop_table(name)
