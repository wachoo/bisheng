"""Store managed skill bindings independently of legacy workflow links."""
import sqlalchemy as sa
from alembic import op

from bisheng.core.database.dialect_helpers import JsonType, column_exists

revision = "assistant_managed_skills"
down_revision = "v3_0_0_tool_openapi_schema_longtext"
branch_labels = None
depends_on = None


def upgrade():
    if not column_exists(op.get_bind(), "assistant", "skill_ids"):
        op.add_column("assistant", sa.Column("skill_ids", JsonType, nullable=True))


def downgrade():
    if column_exists(op.get_bind(), "assistant", "skill_ids"):
        op.drop_column("assistant", "skill_ids")
