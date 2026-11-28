"""Store versioned company dashboard ledger entries."""

from alembic import op
import sqlalchemy as sa

from bisheng.core.database.alembic_helpers.online import table_exists

revision = "f122_board_ledger"
down_revision = "v3_0_0_tool_openapi_schema_longtext"
branch_labels = None
depends_on = None


def upgrade():
    if table_exists("company_board_ledger"):
        return
    op.create_table(
        "company_board_ledger",
        sa.Column("tenant_id", sa.Integer, primary_key=True, autoincrement=False),
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("revision", sa.Integer, primary_key=True, autoincrement=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("year", sa.Integer, nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("indicator", sa.String(16)),
        sa.Column("target", sa.Integer),
        sa.Column("unit", sa.String(16)),
        sa.Column("department_id", sa.Integer),
        sa.Column("parent_id", sa.String(36)),
        sa.Column("asset_key", sa.String(96)),
        sa.Column("effective_date", sa.Date),
        sa.Column("operator_id", sa.Integer, nullable=False),
        sa.Column("recorded_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("ix_board_ledger_period", "company_board_ledger", ["tenant_id", "year", "kind"])


def downgrade():
    if table_exists("company_board_ledger"):
        op.drop_table("company_board_ledger")
