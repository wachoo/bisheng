"""Link a version membership fact to its durable file and version identities."""

import sqlalchemy as sa
from alembic import op

from bisheng.core.database.alembic_helpers.online import column_exists, index_exists

revision = "f122_board_members"
down_revision = "f122_board_feedback"
branch_labels = None
depends_on = None

TABLE = "board_runtime_event"
INDEX = "ix_board_member_file"


def upgrade():
    for name in ("member_file_id", "member_version_id"):
        if not column_exists(TABLE, name):
            op.add_column(TABLE, sa.Column(name, sa.String(64), nullable=True))
    if not index_exists(TABLE, INDEX):
        op.create_index(INDEX, TABLE, ["tenant_id", "member_file_id", "occurred_at"])


def downgrade():
    if index_exists(TABLE, INDEX):
        op.drop_index(INDEX, table_name=TABLE)
    for name in ("member_version_id", "member_file_id"):
        if column_exists(TABLE, name):
            op.drop_column(TABLE, name)
