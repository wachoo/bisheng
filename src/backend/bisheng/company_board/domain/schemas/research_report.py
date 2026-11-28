import itertools
from datetime import date
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Count = Annotated[int, Field(ge=0, le=10**8)]
Amount = Annotated[Decimal, Field(ge=0, max_digits=16, decimal_places=4)]


class ReportMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projects: Count | None = None
    ai_projects: Count | None = None
    active_ai_projects: Count | None = None
    budget: Amount | None = None
    spending: Annotated[Decimal, Field(max_digits=16, decimal_places=4)] | None = None
    outstanding: Amount | None = None
    valued_scenes: Count | None = None
    labor_value: Amount | None = None
    direct_savings: Amount | None = None
    equivalent_days: Amount | None = None
    equivalent_value: Amount | None = None

    @model_validator(mode="after")
    def project_counts(self):
        known_counts = [
            value for value in (self.projects, self.ai_projects, self.active_ai_projects) if value is not None
        ]
        if any(earlier < later for earlier, later in itertools.pairwise(known_counts)):
            raise ValueError("在研 AI 项目数、年度 AI 项目数和科研项目总数的包含关系不符")
        return self


class ResearchSubject(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: UUID
    name: str = Field(min_length=1, max_length=160)
    project: str = Field(min_length=1, max_length=160)
    ai: bool
    start: date
    end: date | None = None

    @model_validator(mode="after")
    def dates(self):
        if self.end is not None and self.end < self.start:
            raise ValueError("结题日期不能早于开始日期")
        return self


class ResearchReportInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)
    revision: int = Field(ge=0)
    metrics: ReportMetrics
    subjects: list[ResearchSubject] = Field(max_length=5000)

    @model_validator(mode="after")
    def distinct_subjects(self):
        if len({s.id for s in self.subjects}) != len(self.subjects):
            raise ValueError("同一课题不可重复登记")
        return self
