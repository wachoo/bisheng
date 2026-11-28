from calendar import monthrange
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.company_board.domain.repositories.research_report import latest_report, save_report
from bisheng.company_board.domain.repositories.supplement import list_supplements
from bisheng.company_board.domain.schemas.research_report import ReportMetrics
from bisheng.company_board.domain.services.boards import require_access, tenant_for

LEGACY_KINDS = ("project", "subject", "expense", "receivable", "receipt", "estimate")
WAN = Decimal(10000)


def _number(value):
    return Decimal(value or 0)


def legacy_values(rows, cutoff):
    year_start = date(cutoff.year, 1, 1)
    projects = {r["id"]: r for r in rows if r["kind"] == "project"}
    ai_ids = {k for k, r in projects.items() if r["fields"].get("ai") == "yes"}

    def active(r):
        end = r["fields"].get("end")
        return r["date"] <= cutoff and (not end or date.fromisoformat(end) >= year_start)

    active_projects = [r for r in projects.values() if active(r)]
    active_ai = [r for r in active_projects if r["id"] in ai_ids]
    running = [r for r in active_ai if not r["fields"].get("end") or date.fromisoformat(r["fields"]["end"]) > cutoff]
    expenses = [r for r in rows if r["kind"] == "expense" and r["year"] == cutoff.year and r["parent_id"] in ai_ids]
    nodes = [r for r in rows if r["kind"] == "receivable" and r["year"] == cutoff.year and r["parent_id"] in ai_ids]
    node_ids = {r["id"] for r in nodes}
    receipts = [r for r in rows if r["kind"] == "receipt" and r["parent_id"] in node_ids]
    estimates = {r["parent_id"]: r["fields"] for r in rows if r["kind"] == "estimate" and r["year"] == cutoff.year}
    subjects = [
        {
            "id": r["id"],
            "name": r["name"],
            "project": projects[r["parent_id"]]["name"],
            "ai": r["fields"].get("ai") == "yes",
            "start": r["date"].isoformat(),
            "end": r["fields"].get("end"),
        }
        for r in rows
        if r["kind"] == "subject" and r["parent_id"] in projects and active(r)
    ]
    metrics = {
        "projects": len(active_projects) if active_projects else None,
        "ai_projects": len(active_ai) if active_projects else None,
        "active_ai_projects": len(running) if active_projects else None,
        "budget": sum((_number(r["fields"]["budget"]) for r in running), Decimal(0)) / WAN
        if active_projects and all(r["fields"].get("budget") for r in running)
        else None,
        "spending": sum((_number(r["fields"]["amount"]) for r in expenses), Decimal(0)) / WAN if expenses else None,
        "outstanding": (
            sum(_number(r["fields"]["amount"]) for r in nodes) - sum(_number(r["fields"]["amount"]) for r in receipts)
        )
        / WAN
        if nodes
        else None,
        "valued_scenes": len(estimates) if estimates else None,
        "labor_value": sum(_number(r.get("hours")) * _number(r.get("hourly")) for r in estimates.values()) / WAN
        if estimates
        else None,
        "direct_savings": sum(_number(r.get("saving")) for r in estimates.values()) / WAN if estimates else None,
    }
    result = ReportMetrics().model_dump(mode="json")
    result.update(
        {key: format(value, ".4f") if isinstance(value, Decimal) else value for key, value in metrics.items()}
    )
    return result, subjects


def _cutoff(year, month):
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if date(year, month, 1) > today:
        raise BoardLedgerInvalidError(msg="请选择当前月份或历史月份")
    return min(today, date(year, month, monthrange(year, month)[1]))


async def read_report(user, board, year, month):
    await require_access(user, board)
    cutoff = _cutoff(year, month)
    tenant = tenant_for(user)
    snapshot = await latest_report(tenant, cutoff)
    if snapshot and snapshot[0].year == year:
        as_of, revision, metrics, subjects, history = snapshot
        return {
            "year": year,
            "month": month,
            "source": "direct",
            "source_month": as_of.month,
            "revision": revision if as_of.month == month else 0,
            "metrics": metrics,
            "subjects": subjects,
            "history": history,
        }
    historical = await list_supplements(tenant, cutoff, LEGACY_KINDS)
    metrics, subjects = legacy_values(historical, cutoff)
    if snapshot:
        # A closed year's report carries forward ongoing subjects only.
        carried = {s["id"]: s for s in snapshot[3] if not s.get("end") or s["end"] >= f"{year}-01-01"}
        # Later legacy subjects may have been entered before the company adopted reporting.
        subjects = [s for s in subjects if s["start"] > snapshot[0].isoformat() and s["id"] not in carried] + list(
            carried.values()
        )
    source = "legacy" if any(v is not None for v in metrics.values()) else "empty"
    return {
        "year": year,
        "month": month,
        "source": source,
        "source_month": None,
        "revision": 0,
        "metrics": metrics,
        "subjects": subjects,
        "history": [],
    }


async def write_report(user, report):
    await require_access(user, "manage")
    cutoff = _cutoff(report.year, report.month)
    if any(s.start > cutoff or (s.end and s.end.year < report.year) for s in report.subjects):
        raise BoardLedgerInvalidError(msg="课题实施期间需与本年度截至填报月的期间重叠")
    await save_report(tenant_for(user), user.user_id, report)
    return await read_report(user, "manage", report.year, report.month)
