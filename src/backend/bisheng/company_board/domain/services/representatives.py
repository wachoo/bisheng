from datetime import date, datetime
from zoneinfo import ZoneInfo

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.company_board.domain.repositories.asset_context import options_from_rows
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.ledger import list_ledger
from bisheng.company_board.domain.repositories.representatives import KIND, save_selection
from bisheng.company_board.domain.repositories.supplement import list_supplements
from bisheng.company_board.domain.services.asset_context import attach_asset_topics
from bisheng.company_board.domain.services.boards import require_access, tenant_for


def effective_day(year):
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    return max(date(year, 1, 1), min(today, date(year, 12, 31)))


async def topic_employees(tenant, year, day):
    plans = await list_ledger(tenant, year, day)
    _, assets = await load_catalog(tenant)
    employees = [asset for asset in assets if asset["kind"] == "employee"]
    await attach_asset_topics(tenant, year, day, employees, plans)
    topics = options_from_rows(tenant, year, plans)["topics"]
    return {t["id"] for t in topics}, employees


def resolve_examples(year, rows, employees):
    """A cleared or unavailable explicit selection supersedes all previous case records."""
    by_id = {asset["id"]: asset for asset in employees}
    current = {r["parent_id"]: r for r in rows if r["year"] == year and r["kind"] == KIND}
    legacy = sorted((r for r in rows if r["year"] == year and r["kind"] == "case"),
                    key=lambda r: (r["date"], r["id"]), reverse=True)
    result = {}
    for case in legacy:
        topic = case["parent_id"]
        for key in case["fields"].get("assets", "").split(","):
            key = key.strip()
            if key in by_id and by_id[key].get("topic_id") == topic and topic not in current:
                result.setdefault(topic, {**case, "fields": {**case["fields"], "assets": key}})
                break
    for topic, record in current.items():
        key = record["fields"].get("asset")
        employee = by_id.get(key)
        if employee and employee.get("topic_id") == topic:
            result[topic] = {**record, "kind": "case", "name": employee["name"],
                             "fields": {"assets": key, "summary": employee.get("description") or ""}}
    return current, result


async def options_for(user, year):
    await require_access(user, "manage")
    tenant, day = tenant_for(user), effective_day(year)
    _, employees = await topic_employees(tenant, year, day)
    rows = await list_supplements(tenant, day, ["case", KIND])
    current, selected = resolve_examples(year, rows, employees)
    return {
        "employees": [{"id": r["id"], "name": r["name"], "topic": r["topic_id"]} for r in employees],
        "selections": {topic: {"asset": selected[topic]["fields"]["assets"] if topic in selected else None,
                               "revision": current[topic]["revision"] if topic in current else 0,
                               "unavailable": bool(topic in current and current[topic]["fields"].get("asset")
                                                   and topic not in selected)}
                       for topic in current.keys() | selected.keys()},
    }


async def save_for(user, year, topic, employee, revision):
    await require_access(user, "manage")
    tenant, day = tenant_for(user), effective_day(year)
    topics, employees = await topic_employees(tenant, year, day)
    if topic not in topics:
        raise BoardLedgerInvalidError(msg="请选择填报年度内的专题")
    if employee is not None and not any(r["id"] == employee and r["topic_id"] == topic for r in employees):
        raise BoardLedgerInvalidError(msg="代表案例须为当前专题已上线的数字员工")
    await save_selection(tenant, user.user_id, topic, year, day, employee, revision)


async def dashboard_cases(tenant, year, day, records):
    ordinary = [r for r in records if r["kind"] not in (KIND, "case")]
    if not any(r["year"] == year and r["kind"] in (KIND, "case") for r in records):
        return ordinary
    _, employees = await topic_employees(tenant, year, day)
    _, selected = resolve_examples(year, records, employees)
    return [*ordinary, *selected.values()]
