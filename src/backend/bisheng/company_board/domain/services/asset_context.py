import json
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.common.errcode.http_error import UnAuthorizedError
from bisheng.common.permission_identity import check_tenant_admin
from bisheng.company_board.domain.repositories.asset_context import (
    bound_scene_options,
    effective_topic,
    latest_bindings,
    legacy_assignments,
    legacy_profile,
    options_from_rows,
    write_binding,
)
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.ledger import list_ledger
from bisheng.company_board.domain.schemas.supplement import SupplementInput
from bisheng.core.database import get_async_db_session
from bisheng.database.models.app import App
from bisheng.database.models.assistant import Assistant
from bisheng.database.models.flow import Flow, FlowType
from bisheng.knowledge.domain.models.knowledge import Knowledge, KnowledgeTypeEnum
from bisheng.linsight.domain.models.linsight_skill import LinsightSkill
from bisheng.permission.application.business_authorization import require_business_action
from bisheng.tool.domain.models.gpts_tools import GptsToolsType


class AssetContextInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    year: int = Field(ge=2000, le=2100)
    topic: str = Field(default="", max_length=36)
    scenes: list[UUID] = Field(default_factory=list, max_length=100)
    profile: dict[str, str] | None = None
    case_name: str = Field(default="", max_length=160)
    case_fields: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_case(self):
        if self.profile is not None:
            if self.profile.keys() - {"direction", "description", "rules"} or any(
                len(v) > 2048 for v in self.profile.values()
            ):
                raise ValueError("Invalid asset profile")
            self.profile = {k: v.strip() for k, v in self.profile.items() if v.strip()}
        self.case_name = self.case_name.strip()
        if self.case_fields.keys() - {"summary", "input", "output", "action", "sampleTitle", "sampleTable"}:
            raise ValueError("Invalid case field")
        if self.case_fields and not self.case_name:
            raise ValueError("A case title is required")
        if self.case_name:
            case = SupplementInput(
                id=UUID(int=1),
                revision=0,
                kind="case",
                name=self.case_name,
                year=self.year,
                date=f"{self.year}-01-01",
                parent_id="topic",
                fields={**self.case_fields, "scene": "_"},
            )
            self.case_fields = {k: v for k, v in case.fields.items() if k != "scene"}
        return self


def today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


async def options(tenant, year):
    return options_from_rows(tenant, year, await list_ledger(tenant, year))


async def require_asset_editor(user, tenant, asset_key):
    prefix, _, ident = asset_key.partition(":")
    sources = {
        "assistant": (Assistant, "assistant", [Assistant.is_delete == 0]),
        "flow": (Flow, "workflow", [Flow.flow_type == FlowType.WORKFLOW.value]),
        "app": (App, "app", []),
        "knowledge": (Knowledge, "knowledge_library", [Knowledge.type != KnowledgeTypeEnum.PRIVATE.value]),
        "skill": (LinsightSkill, None, [LinsightSkill.owner_user_id == 0]),
        "toolset": (GptsToolsType, "tool", [GptsToolsType.is_delete == 0, GptsToolsType.is_preset.in_([0, 2])]),
    }
    if prefix not in sources or not ident or len(asset_key) > 96:
        raise UnAuthorizedError()
    model, perm, filters = sources[prefix]
    if prefix in ("skill", "knowledge", "toolset"):
        if not ident.isascii() or not ident.isdigit() or len(ident) > 10 or ident != str(int(ident)):
            raise UnAuthorizedError()
        ident = int(ident)
    async with get_async_db_session() as db:
        matched = (
            await db.exec(select(model.id).where(model.tenant_id == tenant, model.id == ident, *filters))
        ).first()
    if matched is None:
        raise UnAuthorizedError()
    if perm:
        await require_business_action(user, resource_type=perm, resource_id=ident, action="edit")
    elif not (user.is_global_super or await check_tenant_admin(user.user_id, tenant)):
        raise UnAuthorizedError()


async def attach_asset_topics(tenant, year, cutoff, assets, rows):
    opts = options_from_rows(tenant, year, rows)
    by_key = await latest_bindings(tenant, cutoff)
    old = await legacy_assignments(tenant, year, cutoff, rows)
    known = {r["id"] for r in rows if r["kind"] == "topic"}
    edited_assets = set()
    for asset in assets:
        key = asset.get("context_key") or asset["id"]
        if key in by_key:
            edited_assets.add(asset["id"])
        prior = old.get(asset["id"])
        ident, name = (
            (prior["topic"], prior["topic_name"])
            if key not in by_key and prior
            else effective_topic(by_key.get(key), opts)
        )
        asset["topic_id"] = ident
        if ident not in known:
            rows.append(
                {
                    "kind": "topic",
                    "id": ident,
                    "revision": 0,
                    "name": name,
                    "year": year,
                    "parent_id": None,
                    "asset_key": None,
                    "effective_date": None,
                    "department_id": None,
                    "indicator": None,
                    "target": None,
                    "unit": None,
                }
            )
            known.add(ident)
    # Keep first-release evidence but let the edited scene relationships determine present scope.
    for row in rows:
        if row["kind"] == "release" and row["asset_key"] in edited_assets:
            row["parent_id"] = None


async def read_asset_context(user, tenant, key, year):
    await require_asset_editor(user, tenant, key)
    plan = await list_ledger(tenant, year)
    opts = options_from_rows(tenant, year, plan)
    binding = (await latest_bindings(tenant, key=key)).get(key)
    keys = [key]
    if key.startswith("toolset:"):
        _, assets = await load_catalog(tenant)
        keys += [a["id"] for a in assets if a.get("context_key") == key]
    prior = {}
    if not binding:
        old = await legacy_assignments(tenant, year, today(), plan)
        prior = next((old[k] for k in keys if k in old), {})
    topic, name = (prior["topic"], prior["topic_name"]) if prior else effective_topic(binding, opts)
    if all(t["id"] != topic for t in opts["topics"]):
        opts["topics"].append({"id": topic, "name": name})
    await bound_scene_options(tenant, binding, opts, topic)
    meta = json.loads(binding.payload) if binding else prior
    profile = meta["profile"] if "profile" in meta else await legacy_profile(tenant, keys, today())
    allowed = {s["id"] for s in opts["scenes"] if s["topic"] == topic}
    return {
        **opts,
        "profile": profile,
        "revision": binding.revision if binding else 0,
        "topic": topic,
        "scene_ids": [s for s in meta.get("scenes", []) if s in allowed],
        "case_name": meta.get("case_name", ""),
        "case_fields": meta.get("case_fields", {}),
    }


async def save_asset_context(user, tenant, key, data):
    await require_asset_editor(user, tenant, key)
    day = today()
    if data.year != day.year:
        raise BoardLedgerInvalidError(msg="请重新打开资产设置以切换至新年度")
    opts = await options(tenant, day.year)
    topic = data.topic or opts["default_topic"]
    name = next((t["name"] for t in opts["topics"] if t["id"] == topic), None)
    old = (await latest_bindings(tenant, key=key)).get(key)
    old_topic, old_name = effective_topic(old, opts)
    if old and old_topic == topic:
        name = name or old_name
        await bound_scene_options(tenant, old, opts, topic)
    scenes = sorted({str(s) for s in data.scenes})
    allowed = {s["id"] for s in opts["scenes"] if s["topic"] == topic}
    if not name or set(scenes) - allowed:
        raise BoardLedgerInvalidError(msg="关联场景必须属于当前年度和所选专题")
    payload = {
        "topic": topic,
        "topic_name": name,
        "scenes": scenes,
        "case_name": data.case_name,
        "case_fields": data.case_fields,
    }
    if data.profile is not None:
        payload["profile"] = data.profile
    elif old and "profile" in json.loads(old.payload):
        payload["profile"] = json.loads(old.payload)["profile"]
    revision = await write_binding(tenant, key, user.user_id, data.revision, day, payload)
    return {"revision": revision}
