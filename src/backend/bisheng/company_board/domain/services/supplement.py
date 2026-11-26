from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.company_board.domain.repositories.supplement import list_supplements
from bisheng.company_board.domain.services.boards import reporting_period, require_access, tenant_for
from bisheng.company_board.domain.services.representatives import dashboard_cases, effective_day


async def read(user, board, year, month):
    await require_access(user, board)
    _, end = reporting_period(year, month, datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None))
    cutoff = (end - timedelta(microseconds=1)).date() if board != "manage" else None
    allowed = ["scene-asset", "asset-profile"] if board == "monitor" else None
    tenant = tenant_for(user)
    rows = await list_supplements(tenant, cutoff, allowed)
    if board == "monitor":
        return rows
    return await dashboard_cases(tenant, year, cutoff or effective_day(year), rows)


async def save(user, data):
    await require_access(user, "manage")
    if data.kind in {"case", "scene-asset", "asset-profile"}:
        raise BoardLedgerInvalidError(msg="请在资产编辑页维护归属，在专题管理选择代表案例。")
    raise BoardLedgerInvalidError(msg="请从年度建设计划、知识接入计划或科研与经营表单保存记录。")
