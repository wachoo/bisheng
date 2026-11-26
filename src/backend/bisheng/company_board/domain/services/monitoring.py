from collections import defaultdict
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from bisheng.common.errcode.http_error import NotFoundError
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.feedback import feedback_snapshot
from bisheng.company_board.domain.repositories.ledger import list_ledger, release_departments
from bisheng.company_board.domain.repositories.monitoring import monthly_terminals, own_excerpts, run_receipt
from bisheng.company_board.domain.repositories.supplement import list_supplements
from bisheng.company_board.domain.services.boards import reporting_period, require_access, tenant_for


def iso_utc(value):
    return value.replace(tzinfo=UTC).isoformat() if value else None


def asset_key(kind, identifier):
    return f"{'assistant' if kind == 'employee' else kind}:{identifier}"


def monthly_scope(assets, records, ownership, cutoff, topic, scene, department, kind, reused=()):
    topics = {row["id"]: row["name"] for row in records if row["kind"] == "topic"}
    scenes = {row["id"]: row for row in records if row["kind"] == "scene" and row["parent_id"] in topics}
    connections = defaultdict(set)
    for row in records:
        if (
            row["kind"] == "release"
            and row["parent_id"] in scenes
            and row["effective_date"]
            and row["effective_date"] <= cutoff
        ):
            connections[row["asset_key"]].add(row["parent_id"])
    for link in reused:
        if link["parent_id"] in scenes and link["date"] <= cutoff:
            expiry = link["fields"].get("end")
            if not expiry or expiry >= cutoff.isoformat():
                connections[link["fields"]["asset"]].add(link["parent_id"])
    matches = []
    for asset in assets:
        if asset["kind"] == "skill":
            continue
        asset_scenes = sorted(connections[asset["id"]])
        topic_scenes = [key for key in asset_scenes if not topic or scenes[key]["parent_id"] == topic]
        if (topic and not topic_scenes) or (scene and scene not in topic_scenes):
            continue
        owner = ownership.get(asset["id"])
        if department and department != ("unknown" if owner is None else str(owner)):
            continue
        if kind and asset["kind"] != kind:
            continue
        matches.append({**asset, "department_id": owner, "scene_ids": topic_scenes})
    filters = {
        "topics": [{"id": key, "name": value} for key, value in topics.items()],
        "scenes": [
            {"id": key, "name": row["name"], "topic_id": row["parent_id"]}
            for key, row in scenes.items()
            if not topic or row["parent_id"] == topic
        ],
    }
    return matches, filters


def add_terminal_stats(scoped, known, events):
    assets = {row["id"]: row for row in scoped}
    observed = {asset_key(kind, ident) for kind, ident in known}
    days = defaultdict(lambda: {"success": 0, "failed": 0})
    for row in scoped:
        row.update(monitored=row["id"] in observed, success=0, failed=0, last=None)
    for kind, ident, status, day, count, last in events:
        row = assets.get(asset_key(kind, ident))
        if row is not None:
            row[status] += count
            row["last"] = max(row["last"] or last, last)
            days[day][status] += count
    for row in scoped:
        row["last"] = iso_utc(row["last"])
    return [{"day": day, **values} for day, values in sorted(days.items())]


async def read_scope(tenant, year, cutoff, topic, scene, department, kind):
    records = await list_ledger(tenant, year, cutoff)
    _, catalog = await load_catalog(tenant)
    ownership = await release_departments(tenant, cutoff)
    reused = await list_supplements(tenant, cutoff, ["scene-asset"])
    return monthly_scope(catalog, records, ownership, cutoff, topic, scene, department, kind, reused)


async def read_monitoring(user, board, year, month, topic, scene, department, kind):
    await require_access(user, board)
    tenant = tenant_for(user)
    now = datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    start, end = reporting_period(year, month, now)
    cutoff = (end - timedelta(microseconds=1)).date()
    scope, filters = await read_scope(tenant, year, cutoff, topic, scene, department, kind)
    start, end = start - timedelta(hours=8), end - timedelta(hours=8)
    known, series = await monthly_terminals(tenant, start, end)
    return {"filters": filters, "assets": scope, "days": add_terminal_stats(scope, known, series)}


async def read_issues(user, year, month, topic, scene, department, kind, stage, search, run_id, offset, limit):
    access = await require_access(user, "monitor")
    tenant = tenant_for(user)
    now = datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    start, end = reporting_period(year, month, now)
    cutoff = (end - timedelta(microseconds=1)).date()
    assets, _ = await read_scope(tenant, year, cutoff, topic, scene, department, kind)
    employees = {
        row["id"].removeprefix("assistant:"): row["name"] for row in assets if row["id"].startswith("assistant:")
    }
    # An aggregate-only viewer cannot probe questions, names or run IDs through filtered counts.
    can_read = access["resolve"]
    if (search or run_id) and not can_read:
        await require_access(user, "resolve")
    result = await feedback_snapshot(
        tenant,
        start - timedelta(hours=8),
        end - timedelta(hours=8),
        can_read,
        offset,
        limit,
        employees=employees,
        stage=stage,
        search=search,
        run_id=run_id,
    )
    for row in result["rows"]:
        row["opened_at"] = iso_utc(row["opened_at"])
        row["resolved_at"] = iso_utc(row["resolved_at"])
    return {**result, "details": can_read}


async def read_run(user, run_id, year, month):
    access = await require_access(user, "monitor")
    if not access["resolve"] and not access["manage"]:
        await require_access(user, "resolve")
    tenant = tenant_for(user)
    now = datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    _, end = reporting_period(year, month, now)
    row = await run_receipt(tenant, run_id, end - timedelta(hours=8))
    if row is None:
        raise NotFoundError.http_exception()
    source, output = await own_excerpts(tenant, user.user_id, row)
    issue = None
    if access["resolve"]:
        feedback = await feedback_snapshot(tenant, row.occurred_at, end - timedelta(hours=8), True, 0, 1, run_id=run_id)
        if feedback["rows"]:
            issue = {"comment": feedback["rows"][0]["comment"]}
    return {
        "id": row.run_id,
        "started_at": iso_utc(getattr(row, "started_at", None)),
        "source": source,
        "output": output,
        "own": user.user_id == row.user_id,
        "issue": issue,
        "asset_id": asset_key("employee", row.asset_id),
        "ended_at": iso_utc(row.occurred_at),
        "status": row.status,
        "active_seconds": row.active_seconds,
        "department_id": row.department_id,
    }
