import json
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.common.errcode.http_error import UnAuthorizedError
from bisheng.common.permission_identity import check_tenant_admin
from bisheng.company_board.domain.repositories.asset_context import (
    binding_options,
    effective_topic,
    latest_bindings,
    legacy_assignments,
    options_from_rows,
    write_binding,
)
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.ledger import list_ledger
from bisheng.company_board.domain.repositories.planning import knowledge_targets
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
    knowledge_category_id: UUID | None = None


def today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


async def category_options(tenant, year):
    return [
        {"id": c["id"], "name": c["name"]}
        for c in await knowledge_targets(tenant, year)
        if c.get("assignable", True)
    ]


async def options(tenant, year):
    result = options_from_rows(tenant, year, await list_ledger(tenant, year))
    result.pop("scenes", None)
    result["categories"] = await category_options(tenant, year)
    return result


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
    opts = await binding_options(tenant, year, rows, cutoff)
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
        if asset["kind"] == "knowledge" and key in by_key:
            asset["knowledge_category_id"] = json.loads(by_key[key].payload).get("knowledge_category_id")
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


async def legacy_context(tenant, key, year, plan):
    assignments = await legacy_assignments(tenant, year, today(), plan)
    if key in assignments:
        return assignments[key]
    if key.startswith("toolset:"):
        _, assets = await load_catalog(tenant)
        return next(
            (assignments[a["id"]] for a in assets if a.get("context_key") == key and a["id"] in assignments),
            {},
        )
    return {}


async def read_asset_context(user, tenant, key, year):
    await require_asset_editor(user, tenant, key)
    plan = await list_ledger(tenant, year)
    opts = await binding_options(tenant, year, plan)
    binding = (await latest_bindings(tenant, key=key)).get(key)
    prior = {} if binding else await legacy_context(tenant, key, year, plan)
    topic, name = (prior["topic"], prior["topic_name"]) if prior else effective_topic(binding, opts)
    if all(t["id"] != topic for t in opts["topics"]):
        opts["topics"].append({"id": topic, "name": name})
    meta = json.loads(binding.payload) if binding else {}
    if key.startswith("knowledge:") and "knowledge_category_id" not in meta:
        from bisheng.company_board.domain.repositories.planning import category_key
        from bisheng.company_board.domain.services.knowledge_progress import legacy_connections

        async with get_async_db_session() as db:
            legacy = await legacy_connections(db, tenant, today(), asset_key=key)
        if legacy:
            name = legacy[-1][2]
            meta.update(knowledge_category_id=category_key(tenant, name), knowledge_category_name=name)
    return {
        "year": year,
        "default_topic": opts["default_topic"],
        "topics": opts["topics"],
        "categories": await category_options(tenant, year)
        if key.startswith("knowledge:") else [],
        "revision": binding.revision if binding else 0,
        "topic": topic,
        "knowledge_category_id": meta.get("knowledge_category_id"),
        "knowledge_category_name": meta.get("knowledge_category_name"),
    }


async def save_asset_context(user, tenant, key, data):
    await require_asset_editor(user, tenant, key)
    day = today()
    if data.year != day.year:
        raise BoardLedgerInvalidError(msg="请重新打开资产设置以切换至新年度")
    plan = await list_ledger(tenant, day.year)
    opts = await binding_options(tenant, day.year, plan)
    topic = data.topic or opts["default_topic"]
    name = next((t["name"] for t in opts["topics"] if t["id"] == topic), None)
    old = (await latest_bindings(tenant, key=key)).get(key)
    old_topic, old_name = effective_topic(old, opts)
    prior = {} if old else await legacy_context(tenant, key, day.year, plan)
    if prior:
        old_topic, old_name = prior["topic"], prior["topic_name"]
    if (old or prior) and old_topic == topic:
        name = name or old_name
    if not name:
        raise BoardLedgerInvalidError(msg="请选择当前年度中已有的专题")
    category_id = str(data.knowledge_category_id) if data.knowledge_category_id else None
    if category_id and not key.startswith("knowledge:"):
        raise BoardLedgerInvalidError(msg="只有知识库可以设置业务分类")
    payload = json.loads(old.payload) if old else {
        "scenes": prior.get("scenes", []), "case_name": prior.get("case_name", ""), "case_fields": prior.get("case_fields", {})
    }
    if category_id:
        categories = await category_options(tenant, day.year)
        category = next((c for c in categories if c["id"] == category_id), None)
        if category:
            payload["knowledge_category_id"] = category_id
            payload["knowledge_category_name"] = category["name"]
        elif category_id != payload.get("knowledge_category_id"):
            raise BoardLedgerInvalidError(msg="请选择本年度知识接入计划中已有的业务分类")
    elif key.startswith("knowledge:") and "knowledge_category_id" in data.model_fields_set:
        payload["knowledge_category_id"] = None
        payload.pop("knowledge_category_name", None)
    if old_topic != topic:
        payload["scenes"] = []
    payload.update(topic=topic, topic_name=name)
    revision = await write_binding(tenant, key, user.user_id, data.revision, day, payload)
    return {"revision": revision}
