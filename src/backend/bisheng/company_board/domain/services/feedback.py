from datetime import datetime, timedelta

from bisheng.company_board.domain.repositories import feedback
from bisheng.company_board.domain.services.boards import require_access, tenant_for


async def snapshot(user, year, month, offset, limit):
    access = await require_access(user, "monitor")
    # Web reports use Beijing calendar dates. Storage uses UTC.
    start = datetime(year, month or 1, 1) - timedelta(hours=8)
    if not month or month == 12:
        end = datetime(year + 1, 1, 1)
    else:
        end = datetime(year, month + 1, 1)
    cutoff = min(end - timedelta(hours=8), feedback.utc_now())
    return await feedback.feedback_snapshot(tenant_for(user), start, cutoff, access["resolve"], offset, limit)


async def close(user, run_id, measure):
    await require_access(user, "resolve")
    await feedback.resolve_issue(tenant_for(user), user.user_id, run_id, measure)
