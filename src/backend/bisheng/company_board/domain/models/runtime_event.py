from datetime import datetime

from sqlalchemy import Index
from sqlmodel import Field, SQLModel


class BoardRuntimeEvent(SQLModel, table=True):
    """An observed terminal, dispatch, or delivered file, with no user content."""

    __tablename__ = "board_runtime_event"
    __table_args__ = (
        Index("ix_board_runtime_window", "tenant_id", "occurred_at", "kind"),
        Index("ix_board_member_file", "tenant_id", "member_file_id", "occurred_at"),
    )

    id: str = Field(primary_key=True, max_length=64)
    tenant_id: int | None = Field(default=None, nullable=False)
    run_id: str = Field(max_length=32, index=True)
    user_id: int
    department_id: int | None = None
    kind: str = Field(max_length=20)
    asset_id: str = Field(max_length=128)
    status: str = Field(max_length=16)
    occurred_at: datetime
    active_seconds: float | None = None
    terminal_message_id: int | None = Field(default=None, index=True)
    member_file_id: str | None = Field(default=None, max_length=64)
    member_version_id: str | None = Field(default=None, max_length=64)
