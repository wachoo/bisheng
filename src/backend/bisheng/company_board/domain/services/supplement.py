from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.company_board.domain.repositories.supplement import list_supplements
from bisheng.company_board.domain.services.boards import reporting_period, require_access, tenant_for


async def read(user, board, year, month):
    await require_access(user, board)
    _, end = reporting_period(year, month, datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None))
    cutoff = (end - timedelta(microseconds=1)).date() if board != "manage" else None
    allowed = ["scene-asset", "asset-profile"] if board == "monitor" else None
    return await list_supplements(tenant_for(user), cutoff, allowed)


async def save(user, data):
    await require_access(user, "manage")
    if data.kind in {"case", "scene-asset", "asset-profile"}:
        raise BoardLedgerInvalidError(msg="请在资产创建或编辑页维护业务归属和案例。")
    raise BoardLedgerInvalidError(msg="请从年度建设计划、知识接入计划或科研与经营表单保存记录。")
