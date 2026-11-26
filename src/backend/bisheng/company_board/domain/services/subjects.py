from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from bisheng.common.errcode.http_error import NotFoundError
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.subjects import asset_activity
from bisheng.company_board.domain.services.boards import reporting_period, require_access, tenant_for


async def read_asset_activity(user, board, asset, year, month, window, department, status, search, page):
    access = await require_access(user, board)
    tenant = tenant_for(user)
    _, assets = await load_catalog(tenant)
    if not any(row["id"] == asset for row in assets):
        raise NotFoundError.http_exception()
    now = datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    start, end = reporting_period(year, month, now)
    if window == "year":
        start = datetime(year, 1, 1)
    elif window == "90":
        start = datetime.combine((end - timedelta(microseconds=1)).date() - timedelta(days=89), datetime.min.time())
    result = await asset_activity(
        tenant,
        asset,
        start - timedelta(hours=8),
        end - timedelta(hours=8),
        department,
        access["resolve"] or access["manage"],
        status,
        search.strip(),
        page,
    )
    return result
