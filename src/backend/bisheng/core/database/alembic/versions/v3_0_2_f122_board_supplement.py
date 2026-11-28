"""Store revisioned finance, valuation and topic registers for company boards."""

import sqlalchemy as sa
from alembic import op

from bisheng.core.database.alembic_helpers.online import table_exists

revision = "f122_board_supplement"
down_revision = "f122_board_members"
branch_labels = None
depends_on = None


def upgrade():
    if table_exists("board_supplement"):
        return
    op.create_table(
        "board_supplement",
        sa.Column("tenant_id", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("parent_id", sa.String(96)),
        sa.Column("business_date", sa.Date()),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("operator_id", sa.Integer(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_board_supplement_scope", "board_supplement", ["tenant_id", "kind", "year"])


def downgrade():
    if table_exists("board_supplement"):
        op.drop_table("board_supplement")
