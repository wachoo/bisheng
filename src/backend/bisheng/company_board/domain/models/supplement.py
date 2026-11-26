from datetime import date, datetime

from sqlalchemy import Column, Index, Text
from sqlmodel import Field

from bisheng.common.models.base import SQLModelSerializable


class BoardSupplement(SQLModelSerializable, table=True):
    __tablename__ = "board_supplement"
    __table_args__ = (Index("ix_board_supplement_scope", "tenant_id", "kind", "year"),)

    tenant_id: int = Field(primary_key=True, sa_column_kwargs={"autoincrement": False})
    id: str = Field(primary_key=True, max_length=36)
    revision: int = Field(primary_key=True, sa_column_kwargs={"autoincrement": False})
    kind: str = Field(max_length=20)
    year: int
    name: str = Field(max_length=160)
    parent_id: str | None = Field(default=None, max_length=96)
    business_date: date | None = None
    payload: str = Field(sa_column=Column(Text, nullable=False))
    operator_id: int
    recorded_at: datetime
