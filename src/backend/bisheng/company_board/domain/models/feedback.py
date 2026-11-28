from datetime import datetime

from sqlalchemy import Column, Index, Text
from sqlmodel import Field, SQLModel


class BoardRating(SQLModel, table=True):
    """Changes to the owner's Web feedback, before or after a run receipt arrives."""

    __tablename__ = "board_web_rating"
    __table_args__ = (Index("ix_board_rating_lookup", "tenant_id", "message_id", "rated_at"),)

    id: int | None = Field(default=None, primary_key=True)
    tenant_id: int
    message_id: int
    user_id: int
    rating: int
    comment: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    rated_at: datetime


class BoardIssueResolution(SQLModel, table=True):
    __tablename__ = "board_issue_resolution"

    tenant_id: int = Field(primary_key=True, sa_column_kwargs={"autoincrement": False})
    run_id: str = Field(primary_key=True, max_length=32)
    operator_id: int
    resolved_at: datetime
    measure: str = Field(max_length=500)
