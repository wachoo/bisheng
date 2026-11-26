from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Edit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: str | None = Field(default=None, max_length=64)


class Targets(Edit):
    kind: Literal["targets"]
    employee: int | None = Field(ge=0, le=100_000_000)
    scene: int | None = Field(ge=0, le=100_000_000)


class Item(Edit):
    id: UUID | None = None
    name: str = Field(min_length=1, max_length=160)


class Topic(Item):
    kind: Literal["topic"]
    is_featured: bool | None = None
    delete: bool = False


class DateRange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID | None = None
    start: date
    end: date | None = None

    @model_validator(mode="after")
    def date_order(self):
        if self.end and self.end < self.start:
            raise ValueError("结束日期不能早于开始日期")
        return self


class Support(DateRange):
    department: int = Field(gt=0)


class PlannedItem(Item):
    topic_id: UUID
    department_id: int = Field(gt=0)
    planned_date: date | None = None
    completed_date: date | None = None

    @model_validator(mode="after")
    def actual_in_past(self):
        if self.completed_date and self.completed_date > datetime.now(ZoneInfo("Asia/Shanghai")).date():
            raise ValueError("实际完成日期不能晚于今天")
        return self


class Scene(PlannedItem):
    kind: Literal["scene"]
    supports: list[Support] = Field(default_factory=list, max_length=100)
    recognition: list[DateRange] = Field(default_factory=list, max_length=100)
    support_department_ids: list[Annotated[int, Field(gt=0)]] | None = Field(default=None, max_length=100)
    asset_keys: list[Annotated[str, Field(min_length=1, max_length=160)]] | None = None

    @model_validator(mode="after")
    def unique_periods(self):
        if self.support_department_ids is not None:
            if self.department_id in self.support_department_ids:
                raise ValueError("承建单位无需重复列为支持单位")
            if len(set(self.support_department_ids)) != len(self.support_department_ids):
                raise ValueError("同一支持单位不能重复")
        if self.asset_keys is not None and len(set(self.asset_keys)) != len(self.asset_keys):
            raise ValueError("同一场景不能重复关联一个资产")
        for i, row in enumerate(self.supports):
            if row.department == self.department_id:
                raise ValueError("承建单位无需重复列为支持单位")
            if any(
                s.department == row.department and s.start <= (row.end or date.max) and row.start <= (s.end or date.max)
                for s in self.supports[:i]
            ):
                raise ValueError("同一支持单位的参与期间不能重叠")
        return self


class Collection(Item):
    kind: Literal["collection"]
    name: str = Field(min_length=1, max_length=80)
    target: int = Field(ge=0, le=100_000_000)
    planned_date: date


PlanEdit = Annotated[Targets | Topic | Scene | Collection, Field(discriminator="kind")]
