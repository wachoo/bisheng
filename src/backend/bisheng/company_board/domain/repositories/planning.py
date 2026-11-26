"""Atomic updates to an annual plan line and its dependent records."""

import hashlib
import json
from collections import defaultdict
from datetime import UTC, date, datetime
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.ledger import new_id
from bisheng.company_board.domain.schemas.ledger import LedgerInput
from bisheng.company_board.domain.schemas.planning import Collection, Scene, Targets, Topic
from bisheng.core.database import get_async_db_session
from bisheng.database.models.department import Department

CHILD_KINDS = ("scene-team", "recognition", "collection-meta", "plan-date")


def fields(row):
    return json.loads(row.payload)


def version(rows):
    if not rows:
        return None
    parts = sorted((r.id, r.revision) for r in rows)
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()


def latest(rows):
    # Newest revision first, including corrections that undo a support assignment.
    result = {}
    for row in rows:
        result.setdefault(row.id, row)
    return list(result.values())


async def heads(db, model, tenant, year, kinds, *, parent=None, lock=False):
    stmt = select(model).where(model.tenant_id == tenant, model.year == year, model.kind.in_(kinds))
    if parent:
        stmt = stmt.where(model.parent_id == parent)
    stmt = stmt.order_by(model.id, model.revision.desc())
    if lock:
        stmt = stmt.with_for_update()
    return latest((await db.exec(stmt)).all())


def active(children, kind):
    return sorted(
        [c for c in children if c.kind == kind and not fields(c).get("_removed")],
        key=lambda c: (c.business_date or date.min, c.id),
    )


def read_item(row, children):
    result = {"id": row.id, "name": row.name, "kind": row.kind, "version": version([row, *children])}
    if row.kind == "topic":
        return result
    dates = active(children, "plan-date")
    result.update(
        topic_id=row.parent_id,
        department_id=row.department_id,
        planned_date=fields(dates[-1])["planned"] if dates else None,
        completed_date=row.effective_date,
    )
    if row.kind == "collection":
        categories = active(children, "collection-meta")
        result.update(category=fields(categories[-1]).get("category") if categories else None, asset_key=row.asset_key)
    else:
        result["supports"] = [
            {
                "id": c.id,
                "department": int(fields(c)["department"]),
                "start": c.business_date,
                "end": fields(c).get("end"),
            }
            for c in active(children, "scene-team")
        ]
        result["recognition"] = [
            {"id": c.id, "start": c.business_date, "end": fields(c).get("end")} for c in active(children, "recognition")
        ]
    return result


async def read_plan(tenant, year):
    async with get_async_db_session() as db:
        base = await heads(db, BoardLedger, tenant, year, ("goal", "topic", "scene", "collection"))
        details = await heads(db, BoardSupplement, tenant, year, CHILD_KINDS)
    by_parent = defaultdict(list)
    for detail in details:
        by_parent[detail.parent_id].append(detail)
    goals = [r for r in base if r.kind == "goal" and r.indicator in ("employee", "scene")]
    return {
        "targets": {
            "employee": None,
            "scene": None,
            **{r.indicator: r.target for r in goals},
            "version": version(goals),
        },
        "items": sorted(
            [read_item(r, by_parent[r.id]) for r in base if r.kind != "goal"], key=lambda r: (r["name"], r["id"])
        ),
    }


def check_version(actual, expected):
    if actual != expected:
        raise BoardLedgerConflictError()


def append_base(db, tenant, operator, year, ident, previous, **updates):
    data = previous.model_dump(exclude={"recorded_at"}) if previous else {}
    data.update(updates)
    data.update(
        id=ident, tenant_id=tenant, operator_id=operator, year=year, revision=previous.revision + 1 if previous else 1
    )
    db.add(BoardLedger(**data))


async def save_targets(db, tenant, operator, year, data):
    goals = [
        r
        for r in await heads(db, BoardLedger, tenant, year, ("goal",), lock=True)
        if r.indicator in ("employee", "scene")
    ]
    check_version(version(goals), data.version)
    for indicator, name, unit in (("employee", "年度数字员工建设目标", "位"), ("scene", "年度业务场景投产目标", "个")):
        previous = next((r for r in goals if r.indicator == indicator), None)
        target = getattr(data, indicator)
        if previous and target is None:
            raise BoardLedgerInvalidError(msg="已有目标不能为空。需要清零时请填写 0")
        if target is None or (previous and previous.target == target):
            continue
        value = LedgerInput(year=year, kind="goal", name=name, unit=unit, target=target, indicator=indicator)
        ident = previous.id if previous else new_id(tenant, value)
        append_base(
            db,
            tenant,
            operator,
            year,
            ident,
            previous,
            kind="goal",
            name=previous.name if previous else name,
            indicator=indicator,
            target=target,
            unit=previous.unit if previous else unit,
        )


def append_detail(db, tenant, operator, year, parent, kind, name, day, payload, old=None):
    if old and (fields(old), old.business_date, old.name) == (payload, day, name):
        return
    db.add(
        BoardSupplement(
            tenant_id=tenant,
            operator_id=operator,
            id=old.id if old else str(uuid4()),
            year=year,
            parent_id=parent,
            kind=kind,
            name=name,
            revision=old.revision + 1 if old else 1,
            business_date=day,
            payload=json.dumps(payload, ensure_ascii=False),
            recorded_at=datetime.now(UTC).replace(tzinfo=None),
        )
    )


async def departments_exist(db, tenant, ids):
    if not ids:
        return
    found = set(
        (
            await db.exec(
                select(Department.id).where(
                    Department.tenant_id == tenant,
                    Department.is_deleted == 0,
                    Department.status == "active",
                    Department.id.in_(ids),
                )
            )
        ).all()
    )
    if found != ids:
        raise BoardLedgerInvalidError(msg="请选择当前公司有效的承建或支持单位")


async def write_item(db, tenant, operator, year, data, knowledge_keys):
    if not isinstance(data, Topic):
        for day in (data.planned_date, data.completed_date):
            if day and day.year != year:
                raise BoardLedgerInvalidError(msg="计划和完成日期应在填报年度内")
        if not data.id and not data.planned_date:
            raise BoardLedgerInvalidError(msg="请填写计划日期")
        parent = (
            await db.exec(
                select(BoardLedger.id)
                .where(
                    BoardLedger.tenant_id == tenant,
                    BoardLedger.year == year,
                    BoardLedger.kind == "topic",
                    BoardLedger.id == str(data.topic_id),
                )
                .limit(1)
            )
        ).first()
        if parent is None:
            raise BoardLedgerInvalidError(msg="所属专题不存在或年度不一致")
    standard = LedgerInput(
        year=year, kind=data.kind, name=data.name, parent_id=None if isinstance(data, Topic) else str(data.topic_id)
    )
    ident = str(data.id) if data.id else new_id(tenant, standard)
    old = (
        await db.exec(
            select(BoardLedger)
            .where(
                BoardLedger.tenant_id == tenant,
                BoardLedger.id == ident,
            )
            .order_by(BoardLedger.revision.desc())
            .limit(1)
            .with_for_update()
        )
    ).first()
    if data.id and not old:
        raise BoardLedgerInvalidError(msg="原计划记录不存在")
    if old and (old.year != year or old.kind != data.kind):
        raise BoardLedgerInvalidError(msg="计划类型或年度不符")
    children = await heads(db, BoardSupplement, tenant, year, CHILD_KINDS, parent=ident, lock=True)
    check_version(version(([old] if old else []) + children), data.version)
    base = {"kind": data.kind, "name": data.name}
    if not isinstance(data, Topic):
        ids = {data.department_id} if old is None or old.department_id != data.department_id else set()
        if isinstance(data, Scene):
            former = {r.id: int(fields(r)["department"]) for r in active(children, "scene-team")}
            ids.update(s.department for s in data.supports if former.get(str(s.id)) != s.department)
        await departments_exist(db, tenant, ids)
        base.update(department_id=data.department_id, parent_id=str(data.topic_id), effective_date=data.completed_date)
        if isinstance(data, Collection):
            if (
                data.asset_key
                and data.asset_key not in knowledge_keys
                and not (old and data.asset_key == old.asset_key and data.completed_date == old.effective_date)
            ):
                raise BoardLedgerInvalidError(msg="请选择当前公司已发布的知识库")
            base["asset_key"] = data.asset_key
    append_base(db, tenant, operator, year, ident, old, **base)
    if isinstance(data, Topic):
        return
    jan = date(year, 1, 1)
    dates = active(children, "plan-date")
    if data.planned_date or dates:
        append_detail(
            db,
            tenant,
            operator,
            year,
            ident,
            "plan-date",
            data.name,
            jan,
            {"planned": data.planned_date.isoformat() if data.planned_date else None},
            dates[-1] if dates else None,
        )
    if isinstance(data, Collection):
        categories = active(children, "collection-meta")
        prior = categories[-1] if categories else None
        append_detail(
            db,
            tenant,
            operator,
            year,
            ident,
            "collection-meta",
            data.name,
            prior.business_date if prior else jan,
            {"category": data.category},
            prior,
        )
        return
    for kind, slots in (("scene-team", data.supports), ("recognition", data.recognition)):
        remaining = {r.id: r for r in active(children, kind)}
        for slot in slots:
            if slot.start.year != year:
                raise BoardLedgerInvalidError(msg="参与或认定的开始日期须在填报年度内")
            prior = remaining.pop(str(slot.id), None) if slot.id else None
            if slot.id and not prior:
                raise BoardLedgerInvalidError(msg="子记录不属于当前场景或已重复提交")
            payload = {"end": slot.end.isoformat()} if slot.end else {}
            if kind == "scene-team":
                payload["department"] = str(slot.department)
            append_detail(
                db, tenant, operator, year, ident, kind, prior.name if prior else data.name, slot.start, payload, prior
            )
        for prior in remaining.values():
            append_detail(
                db,
                tenant,
                operator,
                year,
                ident,
                kind,
                prior.name,
                prior.business_date,
                {**fields(prior), "_removed": "1"},
                prior,
            )


async def save_plan(tenant, operator, year, data, knowledge_keys):
    async with get_async_db_session() as db:
        try:
            if isinstance(data, Targets):
                await save_targets(db, tenant, operator, year, data)
            else:
                await write_item(db, tenant, operator, year, data, knowledge_keys)
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise BoardLedgerConflictError() from exc
