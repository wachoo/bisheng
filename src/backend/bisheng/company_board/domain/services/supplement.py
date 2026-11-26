from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.supplement import list_supplements, save_supplement
from bisheng.company_board.domain.services.boards import reporting_period, require_access, tenant_for


async def read(user, board, year, month):
    await require_access(user, board)
    _, end = reporting_period(year, month, datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None))
    cutoff = (end - timedelta(microseconds=1)).date() if board != "manage" else None
    allowed = ["scene-asset", "asset-profile"] if board == "monitor" else None
    return await list_supplements(tenant_for(user), cutoff, allowed)


async def save(user, data):
    await require_access(user, "manage")
    tenant = tenant_for(user)
    _, assets = await load_catalog(tenant) if data.kind in {"scene-asset", "asset-profile", "case"} else ([], [])
    return await save_supplement(tenant, user.user_id, data, {a["id"] for a in assets})
