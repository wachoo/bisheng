"""Atomic updates to an annual plan line and its dependent records."""

import hashlib
import json
from collections import defaultdict
from datetime import UTC, date, datetime
from uuid import NAMESPACE_URL, uuid4, uuid5
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.ledger import new_id, scene_owner
from bisheng.company_board.domain.repositories.topic_state import KIND as TOPIC_STATE, topic_states
from bisheng.company_board.domain.repositories.asset_context import DEFAULT_TOPIC, topic_id
from bisheng.company_board.domain.repositories.planning_departments import (
    board_departments, validate_plan_departments,
)
from bisheng.company_board.domain.repositories.scene_links import SCENE_LINKS
from bisheng.company_board.domain.schemas.ledger import LedgerInput
from bisheng.company_board.domain.schemas.planning import Collection, Scene, Targets, Topic
from bisheng.core.database import get_async_db_session

CHILD_KINDS = ("scene-team", "recognition", "collection-meta", "plan-date", SCENE_LINKS, TOPIC_STATE)


def plan_cutoff(year):
    return min(date(year, 12, 31), datetime.now(ZoneInfo("Asia/Shanghai")).date())


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


async def heads(db, model, tenant, year, kinds, *, parent=None, lock=False, cutoff=None):
    stmt = select(model).where(model.tenant_id == tenant, model.year == year, model.kind.in_(kinds))
    if cutoff:
        stmt = stmt.where((model.business_date.is_(None)) | (model.business_date <= cutoff))
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


def support_is_current(start, end, day):
    return start <= day and (not end or end >= day.isoformat())


def support_periods(children, departments, owner):
    """Unite overlapping legacy assignments of the same reporting department."""
    groups = defaultdict(list)
    for child in active(children, "scene-team"):
        value = fields(child)
        unit = departments.resolve(int(value["department"]))
        if unit is None or unit == owner:
            continue
        periods = groups[unit]
        end = value.get("end")
        if periods and (periods[-1][0]["end"] or "9999-12-31") >= child.business_date.isoformat():
            merged, sources = periods[-1]
            merged["end"] = max(merged["end"], end) if merged["end"] and end else None
            sources.append(child)
        else:
            periods.append(({"id": child.id, "department": unit, "start": child.business_date, "end": end}, [child]))
    return {period["id"]: (period, sources) for periods in groups.values() for period, sources in periods}


def read_item(row, children, departments):
    result = {"id": row.id, "name": row.name, "kind": row.kind, "version": version([row, *children])}
    if row.kind == "topic":
        state = next((fields(c) for c in children if c.kind == TOPIC_STATE), {})
        result["is_featured"] = state.get("is_featured", False)
        return result
    dates = active(children, "plan-date")
    result.update(
        topic_id=row.parent_id,
        department_id=departments.resolve(row.department_id),
        planned_date=fields(dates[-1])["planned"] if dates else None,
        completed_date=row.effective_date,
    )
    result["supports"] = [period for period, _ in support_periods(children, departments, result["department_id"]).values()]
    result["recognition"] = [
        {"id": c.id, "start": c.business_date, "end": fields(c).get("end")} for c in active(children, "recognition")
    ]
    links = active(children, SCENE_LINKS)
    if links:
        result["asset_keys"] = fields(links[0])["assets"]
    return result


def category_key(tenant, name):
    return str(uuid5(NAMESPACE_URL, f"knowledge-category/{tenant}/{name.strip().casefold()}"))


async def category_items(db, tenant, year, cutoff=None):
    # Group historical one-library plans for reading; an explicit category target
    # supersedes that group's derived total without rewriting the original rows.
    old = await heads(db, BoardLedger, tenant, year, ("collection",))
    details = defaultdict(list)
    for row in await heads(db, BoardSupplement, tenant, year, ("collection-meta", "plan-date"), cutoff=cutoff):
        details[row.parent_id].append(row)
    groups = {}
    for row in old:
        children = details[row.id]
        categories = active(children, "collection-meta")
        name = fields(categories[-1])["category"] if categories else "未归类"
        key = category_key(tenant, name)
        group = groups.setdefault(key, {"id": key, "name": name, "target": 0, "planned_date": None, "rows": []})
        group["assignable"] = group.get("assignable", False) or bool(categories)
        group["target"] += 1
        group["rows"].extend([row, *children])
        dates = active(children, "plan-date")
        due = fields(dates[-1]).get("planned") if dates else None
        if due and (not group["planned_date"] or group["planned_date"] < due):
            group["planned_date"] = due
    for row in await heads(db, BoardSupplement, tenant, year, ("category-plan",), cutoff=cutoff):
        groups[row.parent_id] = {"id": row.parent_id, "name": row.name, **fields(row), "assignable": True, "rows": [row]}
    for item in groups.values():
        item["version"] = version(item.pop("rows"))
        item["kind"] = "collection"
    return sorted(groups.values(), key=lambda r: (r["name"], r["id"]))


async def knowledge_targets(tenant, year, cutoff=None):
    async with get_async_db_session() as db:
        return await category_items(db, tenant, year, cutoff)


async def save_category(db, tenant, operator, year, data):
    if data.planned_date.year != year:
        raise BoardLedgerInvalidError(msg="计划完成日期应在填报年度内")
    # One optimistic revision per annual list also covers concurrent renames
    # and duplicate inserts when no category row exists to lock yet.
    guards = await heads(db, BoardSupplement, tenant, year, ("category-list",), lock=True)
    guard = guards[0] if guards else None
    items = await category_items(db, tenant, year)
    key = str(data.id) if data.id else None
    current = next((r for r in items if r["id"] == key), None)
    if key and not current:
        raise BoardLedgerInvalidError(msg="原业务分类计划不存在")
    check_version(current["version"] if current else None, data.version)
    if any(r["name"].casefold() == data.name.casefold() and r["id"] != key for r in items):
        raise BoardLedgerInvalidError(msg="本年度已登记同名业务分类")
    if not key:
        # Carry the most recent matching category forward, including a renamed one.
        history = (await db.exec(select(BoardSupplement).where(
            BoardSupplement.tenant_id == tenant, BoardSupplement.kind == "category-plan",
            BoardSupplement.name == data.name
        ).order_by(BoardSupplement.recorded_at.desc()).limit(1))).first()
        key = history.parent_id if history else category_key(tenant, data.name)
        if any(r["id"] == key for r in items):
            key = str(uuid4())
    row_id = str(uuid5(NAMESPACE_URL, f"knowledge-target/{tenant}/{year}/{key}"))
    previous = (await db.exec(select(BoardSupplement).where(
        BoardSupplement.tenant_id == tenant, BoardSupplement.id == row_id
    ).order_by(BoardSupplement.revision.desc()).limit(1))).first()
    for ident, kind, name, parent, revision, payload in (
        (row_id, "category-plan", data.name, key, previous.revision + 1 if previous else 1,
         {"target": data.target, "planned_date": data.planned_date.isoformat()}),
        (str(uuid5(NAMESPACE_URL, f"knowledge-list/{tenant}/{year}")), "category-list", "知识接入计划", None,
         guard.revision + 1 if guard else 1, {}),
    ):
        db.add(BoardSupplement(id=ident, tenant_id=tenant, operator_id=operator, year=year,
                               revision=revision, kind=kind, name=name, parent_id=parent,
                               business_date=date(year, 1, 1), payload=json.dumps(payload, ensure_ascii=False),
                               recorded_at=datetime.now(UTC).replace(tzinfo=None)))


async def read_plan(tenant, year):
    async with get_async_db_session() as db:
        base = await heads(db, BoardLedger, tenant, year, ("goal", "topic", "scene"))
        details = await heads(db, BoardSupplement, tenant, year, CHILD_KINDS)
        deleted = {r.parent_id for r in details if r.kind == TOPIC_STATE and fields(r).get("deleted")}
        base = [r for r in base if r.id not in deleted]
        categories = await category_items(db, tenant, year)
        departments = await board_departments(db, tenant)
    by_parent = defaultdict(list)
    for detail in details:
        by_parent[detail.parent_id].append(detail)
    goals = [r for r in base if r.kind == "goal" and r.indicator in ("employee", "scene")]
    return {
        "departments": departments.options,
        "historical_departments": [],
        "targets": {
            "employee": None,
            "scene": None,
            **{r.indicator: r.target for r in goals},
            "version": version(goals),
        },
        "items": sorted(
            [read_item(r, by_parent[r.id], departments) for r in base if r.kind != "goal"] + categories, key=lambda r: (r["name"], r["id"])
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


async def write_item(db, tenant, operator, year, data, available_assets, inherited_assets):
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
                .order_by(BoardLedger.revision.desc()).limit(1).with_for_update()
            )
        ).first()
        if parent is None or (await topic_states(db, tenant, topic=parent)).get(parent, {}).get("deleted"):
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
    state = next((c for c in children if c.kind == TOPIC_STATE), None)
    while state and fields(state).get("deleted"):
        if not isinstance(data, Topic) or data.id or data.delete:
            raise BoardLedgerInvalidError(msg="专题已删除")
        # A new topic may reuse the old display name, but never its asset links.
        ident = str(uuid5(NAMESPACE_URL, "replacement-topic/" + ident))
        old = (await db.exec(select(BoardLedger).where(
            BoardLedger.tenant_id == tenant, BoardLedger.id == ident
        ).order_by(BoardLedger.revision.desc()).limit(1).with_for_update())).first()
        children = await heads(db, BoardSupplement, tenant, year, CHILD_KINDS, parent=ident, lock=True)
        state = next((c for c in children if c.kind == TOPIC_STATE), None)
    check_version(version(([old] if old else []) + children), data.version)
    base = {"kind": data.kind, "name": data.name}
    if not isinstance(data, Topic):
        departments = await board_departments(db, tenant)
        requested_supports = data.support_department_ids if data.support_department_ids is not None else [s.department for s in data.supports]
        ids = set(requested_supports)
        if data.department_id is not None:
            ids.add(data.department_id)
        await validate_plan_departments(db, tenant, ids)
        owner = scene_owner(departments, old, data.department_id)
        base.update(department_id=owner, parent_id=str(data.topic_id), effective_date=data.completed_date)
    append_base(db, tenant, operator, year, ident, old, **base)
    if isinstance(data, Topic):
        if data.delete:
            if not old:
                raise BoardLedgerInvalidError(msg="原专题不存在")
            if "".join(old.name.split()) == DEFAULT_TOPIC or ident == topic_id(tenant, year, DEFAULT_TOPIC):
                raise BoardLedgerInvalidError(msg="默认专题用于承接未指定专题的资产，无法删除")
            scenes = [r.name for r in await heads(db, BoardLedger, tenant, year, ("scene",), lock=True)
                      if r.parent_id == ident]
            if scenes:
                raise BoardLedgerInvalidError(msg="请先编辑以下场景，更换所属专题：" + "、".join(sorted(scenes)))
        if data.is_featured is not None or data.delete:
            day = max(date(year, 1, 1), plan_cutoff(year))
            append_detail(db, tenant, operator, year, ident, TOPIC_STATE, data.name, day,
                          {"is_featured": bool(data.is_featured), "deleted": data.delete}, state)
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
    if data.asset_keys is not None:
        managed = active(children, SCENE_LINKS)
        prior = managed[0] if managed else None
        previous_keys = set(fields(prior)["assets"]) if prior else set(inherited_assets)
        selected = set(data.asset_keys)
        if selected - previous_keys - available_assets:
            raise BoardLedgerInvalidError(msg="请选择当前公司资产目录中的 AI 资产")
        if selected != previous_keys:
            append_detail(db, tenant, operator, year, ident, SCENE_LINKS, data.name, jan,
                          {"assets": sorted(selected)}, prior)

    slots_by_kind = {}
    periods = support_periods(children, departments, data.department_id)
    if data.support_department_ids is not None:
        requested = set(data.support_department_ids)
        day = max(date(year, 1, 1), plan_cutoff(year))
        current = {p["department"] for p, _ in periods.values() if support_is_current(p["start"], p["end"], day)}
        # Hidden and out-of-scope historical assignments are not editable choices.
        for row in (source for _, sources in periods.values() for source in sources):
            value = fields(row)
            raw_department = int(value["department"])
            department = departments.resolve(raw_department)
            if value.get("end") and value["end"] < day.isoformat():
                continue
            if department not in requested or row.business_date > day:
                append_detail(db, tenant, operator, year, ident, "scene-team", row.name, row.business_date,
                              {**value, "_removed": "1"}, row)
            elif value.get("end") and raw_department == department:
                # A date-free selection remains assigned until an administrator removes it.
                append_detail(db, tenant, operator, year, ident, "scene-team", row.name, row.business_date,
                              {"department": str(department)}, row)
        for department in sorted(requested - current):
            append_detail(db, tenant, operator, year, ident, "scene-team", data.name, jan,
                          {"department": str(department)})
    elif "supports" in data.model_fields_set:
        slots_by_kind["scene-team"] = data.supports
    if "recognition" in data.model_fields_set:
        slots_by_kind["recognition"] = data.recognition
    for kind, slots in slots_by_kind.items():
        remaining = ({r.id: r for _, sources in periods.values() for r in sources} if kind == "scene-team"
                     else {r.id: r for r in active(children, kind)})
        for slot in slots:
            if slot.start.year != year:
                raise BoardLedgerInvalidError(msg="参与或认定的开始日期须在填报年度内")
            prior = remaining.pop(str(slot.id), None) if slot.id else None
            if slot.id and not prior:
                raise BoardLedgerInvalidError(msg="子记录不属于当前场景或已重复提交")
            payload = {"end": slot.end.isoformat()} if slot.end else {}
            if kind == "scene-team":
                if prior and str(slot.id) in periods:
                    period, sources = periods[str(slot.id)]
                    if (period["department"], period["start"], period["end"]) == (
                        slot.department, slot.start, payload.get("end")
                    ):
                        for source in sources[1:]:
                            remaining.pop(source.id)
                        continue
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


async def save_plan(tenant, operator, year, data, *, available_assets=frozenset(), inherited_assets=()):
    async with get_async_db_session() as db:
        try:
            if isinstance(data, Targets):
                await save_targets(db, tenant, operator, year, data)
            elif isinstance(data, Collection):
                await save_category(db, tenant, operator, year, data)
            else:
                await write_item(db, tenant, operator, year, data, available_assets, inherited_assets)
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise BoardLedgerConflictError() from exc
