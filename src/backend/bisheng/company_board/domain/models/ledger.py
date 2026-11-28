from datetime import date, datetime

from sqlalchemy import Column, DateTime, Index, Integer, String, text
from sqlmodel import Field

from bisheng.common.models.base import SQLModelSerializable


class BoardLedger(SQLModelSerializable, table=True):
    """Append-only revisions. Tenant and record ID scope both reads and writes."""

    __tablename__ = "company_board_ledger"
    __table_args__ = (Index("ix_board_ledger_period", "tenant_id", "year", "kind"),)

    tenant_id: int = Field(sa_column=Column(Integer, primary_key=True, autoincrement=False))
    id: str = Field(sa_column=Column(String(36), primary_key=True))
    revision: int = Field(sa_column=Column(Integer, primary_key=True, autoincrement=False))
    kind: str = Field(max_length=16)
    year: int
    name: str = Field(max_length=160)
    indicator: str | None = Field(default=None, max_length=16)
    target: int | None = None
    unit: str | None = Field(default=None, max_length=16)
    department_id: int | None = None
    parent_id: str | None = Field(default=None, max_length=36)
    asset_key: str | None = Field(default=None, max_length=96)
    effective_date: date | None = None
    operator_id: int
    recorded_at: datetime | None = Field(
        default=None, sa_column=Column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    )
