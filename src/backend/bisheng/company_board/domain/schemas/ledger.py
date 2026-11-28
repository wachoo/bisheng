from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

BoardKind = Literal["lead", "monitor"]
LedgerKind = Literal["goal", "topic", "scene", "release", "collection"]
Indicator = Literal["employee", "scene", "knowledge"]


class LedgerInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    kind: LedgerKind
    year: int = Field(ge=2000, le=2100)
    name: str = Field(min_length=1, max_length=160)
    indicator: Indicator | None = None
    target: int | None = Field(default=None, ge=0, le=100_000_000)
    unit: str | None = Field(default=None, max_length=16)
    department_id: int | None = Field(default=None, gt=0)
    parent_id: str | None = Field(default=None, min_length=1, max_length=36)
    asset_key: str | None = Field(default=None, min_length=1, max_length=96)
    effective_date: date | None = None

    @model_validator(mode="after")
    def validate_kind(self):
        if self.kind == "goal":
            if not self.indicator or self.target is None or not self.unit:
                raise ValueError("年度目标需要指标、目标数和单位")
        elif self.target is not None or self.unit or self.indicator:
            raise ValueError("只有年度目标可以指定指标、目标数和单位")
        if (self.kind in {"scene", "release", "collection"}) != bool(self.parent_id):
            raise ValueError("场景和知识集请选择所属专题。计划内资产请选择所属场景。")
        if self.kind == "release" and not self.asset_key:
            raise ValueError("计划内资产必须关联资产目录")
        if self.kind == "collection" and self.effective_date and not self.asset_key:
            raise ValueError("验证通过必须关联实际检索验证的知识库")
        if self.asset_key and self.kind not in {"release", "collection"}:
            raise ValueError("该类台账不关联资产")
        return self


class LedgerEdit(LedgerInput):
    revision: int = Field(ge=1)
