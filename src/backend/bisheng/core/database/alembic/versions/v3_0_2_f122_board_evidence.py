"""Add nullable provider receipts, start times, delivery categories and owner feedback."""

import sqlalchemy as sa
from alembic import op

from bisheng.core.database.alembic_helpers.online import column_exists

revision = "f122_board_evidence"
down_revision = "f122_board_supplement"
branch_labels = None
depends_on = None

columns = {
    "board_runtime_event": {
        "started_at": sa.DateTime,
        "input_message_id": sa.Integer,
        "input_tokens": sa.Integer,
        "output_tokens": sa.Integer,
        "output_category": sa.String(16),
    },
    "board_web_rating": {"comment": sa.Text},
}


def upgrade():
    for table, fields in columns.items():
        for name, datatype in fields.items():
            if not column_exists(table, name):
                op.add_column(table, sa.Column(name, datatype, nullable=True))


def downgrade():
    for table, fields in columns.items():
        for name in fields:
            if column_exists(table, name):
                op.drop_column(table, name)
