from datetime import date, datetime
from zoneinfo import ZoneInfo

from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.ledger import list_ledger
from bisheng.company_board.domain.repositories.planning import read_plan, save_plan
from bisheng.company_board.domain.schemas.planning import Collection
from bisheng.company_board.domain.services.boards import require_access, tenant_for


async def plan_for(user, year):
    await require_access(user, "manage")
    tenant = tenant_for(user)
    plan = await read_plan(tenant, year)
    departments, assets = await load_catalog(tenant)
    cutoff = min(date(year, 12, 31), datetime.now(ZoneInfo("Asia/Shanghai")).date())
    ledger = await list_ledger(tenant, year, cutoff)
    built = {
        r["asset_key"]
        for r in ledger
        if r["kind"] == "release"
        and r.get("asset_key")
        and r["asset_key"].startswith(("assistant:", "flow:", "app:"))
        and r["effective_date"]
        and date(year, 1, 1) <= r["effective_date"] <= cutoff
    }
    return {
        **plan,
        "built": len(built),
        "departments": departments,
        "knowledge": [{"id": a["id"], "name": a["name"]} for a in assets if a["kind"] == "knowledge"],
    }


async def update_plan(user, year, edit):
    await require_access(user, "manage")
    tenant = tenant_for(user)
    _, assets = await load_catalog(tenant) if isinstance(edit, Collection) and edit.asset_key else ([], [])
    await save_plan(tenant, user.user_id, year, edit, {a["id"] for a in assets if a["kind"] == "knowledge"})
