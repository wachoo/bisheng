import json
from datetime import date as Date
from decimal import Decimal, InvalidOperation
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Kind = Literal[
    "project",
    "subject",
    "expense",
    "receivable",
    "receipt",
    "estimate",
    "recognition",
    "case",
    "collection-meta",
    "asset-profile",
    "scene-asset",
    "scene-team",
    "value-rate",
]
# field names stored in the register and their input formats
FIELDS = {
    "project": {"ai": "flag", "end": "date", "budget": "amount"},
    "subject": {"ai": "flag", "end": "date"},
    "expense": {"amount": "signed"},
    "receivable": {"amount": "amount", "contract": "text"},
    "receipt": {"amount": "amount"},
    "estimate": {"hours": "amount", "hourly": "amount", "saving": "amount"},
    "recognition": {"end": "date"},
    "case": {
        "scene": "text",
        "assets": "list",
        "input": "text",
        "output": "text",
        "summary": "summary",
        "sampleTitle": "title",
        "action": "action",
        "sampleTable": "table",
    },
    "collection-meta": {"category": "text"},
    "asset-profile": {"direction": "text", "description": "text", "rules": "text"},
    "scene-asset": {"asset": "text", "end": "date"},
    "scene-team": {"department": "department", "end": "date"},
    "value-rate": {"category": "category", "unit": "unit", "hours": "amount", "hourly": "amount"},
}
PARENTS = {
    "subject": "project",
    "expense": "project",
    "receivable": "project",
    "receipt": "receivable",
    "estimate": "scene",
    "recognition": "scene",
    "case": "topic",
    "collection-meta": "collection",
    "asset-profile": "asset",
    "scene-asset": "scene",
    "scene-team": "scene",
}
REQUIRED = {
    "project": ["ai"],
    "subject": ["ai"],
    "expense": ["amount"],
    "receivable": ["amount", "contract"],
    "receipt": ["amount"],
    "estimate": ["hours", "hourly", "saving"],
    "case": ["scene"],
    "collection-meta": ["category"],
    "scene-asset": ["asset"],
    "scene-team": ["department"],
    "value-rate": ["category", "unit", "hours", "hourly"],
}


class SupplementInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: UUID
    revision: int = Field(ge=0)
    year: int = Field(ge=2000, le=2100)
    kind: Kind
    name: str = Field(min_length=1, max_length=160)
    parent_id: str | None = Field(default=None, max_length=96)
    date: Date
    fields: dict[str, str]

    @model_validator(mode="after")
    def validate_fields(self):
        allowed = FIELDS[self.kind]
        if bool(PARENTS.get(self.kind)) != bool(self.parent_id):
            raise ValueError("请选择对应的业务对象")
        if self.fields.keys() - allowed.keys() or any(
            not self.fields.get(k, "").strip() for k in REQUIRED.get(self.kind, [])
        ):
            raise ValueError("请检查该类记录的必填字段")
        self.fields = {k: v.strip() for k, v in self.fields.items() if v.strip()}
        for k, v in self.fields.items():
            fmt = allowed[k]
            if fmt == "table":
                if len(v.encode("utf-8")) > 24000:
                    raise ValueError("案例样表内容过长")
                try:
                    grid = json.loads(v)
                except (ValueError, RecursionError) as exc:
                    raise ValueError("案例样表无法解析") from exc
                if not isinstance(grid, list) or not 2 <= len(grid) <= 21 or not all(isinstance(r, list) for r in grid):
                    raise ValueError("案例样表需要表头和 1 至 20 行数据")
                head = grid[0]
                if not 1 <= len(head) <= 8 or any(not isinstance(c, str) or not c.strip() or len(c) > 64 for c in head):
                    raise ValueError("请填写 1 至 8 个表头。每列不超过 64 字")
                if any(
                    len(row) != len(head)
                    or any(not isinstance(c, str) or len(c) > 256 for c in row)
                    or not any(c.strip() for c in row)
                    for row in grid[1:]
                ):
                    raise ValueError("数据行列数须与表头一致。每格最多 256 字。每行至少有一项内容")
                continue
            if len(v) > {"summary": 512, "title": 100, "action": 40}.get(fmt, 2048):
                raise ValueError("字段超过长度限制")
            if fmt == "department" and (not v.isascii() or not v.isdecimal() or int(v) < 1 or int(v) > 2147483647):
                raise ValueError("请选择有效的部门")
            if fmt in {"amount", "signed"}:
                try:
                    n = Decimal(v)
                except InvalidOperation as exc:
                    raise ValueError("金额或工时格式不正确") from exc
                if (
                    not n.is_finite()
                    or n.copy_abs() > 10**14
                    or (n < 0 and fmt != "signed")
                    or n.as_tuple().exponent < -4
                ):
                    raise ValueError("金额或工时超出有效范围")
            if fmt == "date" and Date.fromisoformat(v) < self.date:
                raise ValueError("结束日期早于生效日期")
            enums = {
                "flag": {"yes", "no"},
                "category": {"document", "image", "page", "other"},
                "unit": {"file", "version"},
            }
            if fmt in enums and v not in enums[fmt]:
                raise ValueError("无效的分类或单位")
        if self.date.year != self.year:
            raise ValueError("记录年度须与业务日期一致")
        if self.kind == "asset-profile" and not self.fields:
            raise ValueError("请填写至少一项资产资料")
        return self
