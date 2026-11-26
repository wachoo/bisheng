"""Asset authors maintain business attribution independently of board operators."""

import json
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import and_, func
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerConflictError
from bisheng.company_board.domain.models.supplement import BoardSupplement as Row
from bisheng.core.database import get_async_db_session

KIND = "asset-binding"
DEFAULT_TOPIC = "AI先锋行动"


def topic_id(tenant, year, name):
    # Same identity as the annual plan when a planner subsequently creates the topic.
    return str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant}:{year}:topic:None:{name}"))


def binding_id(tenant, key):
    return str(uuid5(NAMESPACE_URL, f"bisheng:board:{tenant}:asset-binding:{key}"))


async def latest_bindings(tenant, cutoff=None, key=None):
    latest = select(Row.id, func.max(Row.revision).label("version")).where(Row.tenant_id == tenant, Row.kind == KIND)
    if cutoff:
        latest = latest.where(Row.business_date <= cutoff)
    if key:
        latest = latest.where(Row.parent_id == key)
    latest = latest.group_by(Row.id).subquery()
    query = (
        select(Row)
        .join(latest, and_(Row.id == latest.c.id, Row.revision == latest.c.version))
        .where(Row.tenant_id == tenant, Row.kind == KIND)
    )
    async with get_async_db_session() as db:
        return {r.parent_id: r for r in (await db.exec(query)).all()}


async def write_binding(tenant, key, actor, expected, day, payload):
    ident = binding_id(tenant, key)
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    async with get_async_db_session() as db:
        query = select(Row).where(Row.tenant_id == tenant, Row.id == ident).order_by(Row.revision.desc()).limit(1)
        old = (await db.exec(query.with_for_update())).first()
        if old and old.payload == serialized:
            return old.revision
        if (old.revision if old else 0) != expected:
            raise BoardLedgerConflictError()
        row = Row(
            tenant_id=tenant,
            id=ident,
            kind=KIND,
            parent_id=key,
            revision=expected + 1,
            year=day.year,
            business_date=day,
            name=payload["topic_name"],
            payload=serialized,
            operator_id=actor,
            recorded_at=datetime.now(UTC).replace(tzinfo=None),
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            if (latest := (await db.exec(query)).first()) and latest.payload == serialized:
                return latest.revision
            raise BoardLedgerConflictError() from exc
        return expected + 1


def options_from_rows(tenant, year, rows):
    topics = [{"id": r["id"], "name": r["name"]} for r in rows if r["kind"] == "topic"]
    default = next((r["id"] for r in topics if r["name"] == DEFAULT_TOPIC), None)
    if default is None:
        default = next((r["id"] for r in topics if "".join(r["name"].split()) == DEFAULT_TOPIC), None)
    if default is None:
        default = topic_id(tenant, year, DEFAULT_TOPIC)
        topics.append({"id": default, "name": DEFAULT_TOPIC})
    return {
        "year": year,
        "default_topic": default,
        "topics": topics,
        "scenes": [{"id": r["id"], "name": r["name"], "topic": r["parent_id"]} for r in rows if r["kind"] == "scene"],
    }


def effective_topic(binding, options):
    if not binding:
        return options["default_topic"], DEFAULT_TOPIC
    meta = json.loads(binding.payload)
    current = next((t for t in options["topics"] if t["id"] == meta["topic"]), None)
    if not current:
        current = next((t for t in options["topics"] if t["name"] == meta["topic_name"]), None)
    if not current and "".join(meta["topic_name"].split()) == DEFAULT_TOPIC:
        current = next((t for t in options["topics"] if t["id"] == options["default_topic"]), None)
    return (
        (current["id"], current["name"])
        if current
        else (topic_id(binding.tenant_id, options["year"], meta["topic_name"]), meta["topic_name"])
    )


async def legacy_assignments(tenant, year, cutoff, plan):
    """Index legacy scene links and representative cases by asset within a reporting year."""
    latest = (
        select(Row.id, func.max(Row.revision).label("version"))
        .where(
            Row.tenant_id == tenant,
            Row.year == year,
            Row.kind.in_(("case", "scene-asset")),
            Row.business_date <= cutoff,
        )
        .group_by(Row.id)
        .subquery()
    )
    query = (
        select(Row)
        .join(latest, and_(Row.id == latest.c.id, Row.revision == latest.c.version))
        .where(Row.tenant_id == tenant)
        .order_by(Row.business_date, Row.id)
    )
    async with get_async_db_session() as db:
        old = (await db.exec(query)).all()
    scene_topics = {r["id"]: r["parent_id"] for r in plan if r["kind"] == "scene"}
    topics = {r["id"]: r["name"] for r in plan if r["kind"] == "topic"}
    by_asset = {}

    def add(key, topic, scene=None, case=None):
        if not key or topic not in topics:
            return
        data = by_asset.setdefault(
            key, {"topic": topic, "topic_name": topics[topic], "scenes": [], "case_name": "", "case_fields": {}}
        )
        if scene and scene_topics.get(scene) == topic and scene not in data["scenes"]:
            data["scenes"].append(scene)
        if case:
            data.update(
                topic=topic,
                topic_name=topics[topic],
                case_name=case.name,
                case_fields={k: v for k, v in json.loads(case.payload).items() if k not in ("scene", "assets")},
            )

    for row in plan:
        if row["kind"] == "release" and row.get("effective_date") and row["effective_date"] <= cutoff:
            add(row["asset_key"], scene_topics.get(row["parent_id"]), row["parent_id"])
    for row in old:
        fields = json.loads(row.payload)
        if row.kind == "case":
            for key in fields.get("assets", "").split(","):
                add(key.strip(), row.parent_id, fields.get("scene"), row)
        elif not fields.get("end") or fields["end"] >= cutoff.isoformat():
            add(fields["asset"], scene_topics.get(row.parent_id), row.parent_id)
    return by_asset


async def binding_history(tenant, cutoff):
    query = select(Row).where(Row.kind == KIND, Row.tenant_id == tenant, Row.business_date <= cutoff)
    async with get_async_db_session() as db:
        return (await db.exec(query.order_by(Row.parent_id, Row.business_date, Row.revision))).all()


async def bound_scene_options(tenant, binding, opts, topic):
    if not binding:
        return
    from bisheng.company_board.domain.models.ledger import BoardLedger

    missing = set(json.loads(binding.payload)["scenes"]) - {s["id"] for s in opts["scenes"]}
    if not missing:
        return
    query = (
        select(BoardLedger)
        .where(BoardLedger.tenant_id == tenant, BoardLedger.kind == "scene", BoardLedger.id.in_(missing))
        .order_by(BoardLedger.revision.desc())
    )
    async with get_async_db_session() as db:
        for r in (await db.exec(query)).all():
            if r.id in missing:
                opts["scenes"].append({"id": r.id, "name": f"{r.year} · {r.name}", "topic": topic})
                missing.remove(r.id)


async def legacy_profile(tenant, keys, cutoff):
    versions = (
        select(Row.id, func.max(Row.revision).label("version"))
        .where(
            Row.tenant_id == tenant,
            Row.kind == "asset-profile",
            Row.parent_id.in_(keys),
            Row.business_date <= cutoff,
        )
        .group_by(Row.id)
        .subquery()
    )
    query = (
        select(Row)
        .join(versions, and_(Row.id == versions.c.id, Row.revision == versions.c.version))
        .where(Row.tenant_id == tenant)
        .order_by(Row.business_date.desc(), Row.id.desc())
        .limit(1)
    )
    async with get_async_db_session() as db:
        row = (await db.exec(query)).first()
    return json.loads(row.payload) if row else {}


async def first_binding_dates(tenant, cutoff):
    query = (
        select(Row.parent_id, func.min(Row.business_date))
        .where(
            Row.tenant_id == tenant,
            Row.kind == KIND,
            Row.business_date <= cutoff,
        )
        .group_by(Row.parent_id)
    )
    async with get_async_db_session() as db:
        return dict((await db.exec(query)).all())
