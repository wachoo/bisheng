from datetime import UTC, datetime, timedelta

from bisheng.company_board.domain.repositories.activity_trends import grouped_trends
from bisheng.company_board.domain.repositories.catalog import load_catalog


def report_periods(year, month, now):
    beijing = timedelta(hours=8)
    starts = [datetime(year, m, 1) - beijing for m in range(1, month + 1)]
    next_month = datetime(year + int(month == 12), month % 12 + 1, 1) - beijing
    end = min(next_month, now)
    months = [
        (i + 1, start, min(finish, now))
        for i, (start, finish) in enumerate(zip(starts, [*starts[1:], next_month], strict=True))
    ]
    # Both the selected cutoff date and the starting date are inclusive in Beijing.
    last_day = (end + beijing - timedelta(microseconds=1)).date()
    start_90 = datetime.combine(last_day - timedelta(days=89), datetime.min.time()) - beijing
    return [*months, (0, starts[0], end), (-1, start_90, end)]


async def read_trends(user, board, year, month):
    from bisheng.company_board.domain.services.boards import require_access, tenant_for

    await require_access(user, board)
    tenant = tenant_for(user)
    _, catalog = await load_catalog(tenant)
    visible = {row["id"] for row in catalog}
    periods = report_periods(year, month, datetime.now(UTC).replace(tzinfo=None))
    rows, unknown_since = await grouped_trends(tenant, periods)
    groups = {
        index: {"month": index, "rows": [], "files_known": unknown_since is None or unknown_since >= end}
        for index, _, end in periods
    }
    for row in rows:
        group = groups[row.pop("period")]
        prefix = "assistant" if row["kind"] in {"employee", "file", "version", "model"} else row["kind"]
        asset_id = f"{prefix}:{row['asset_id']}"
        row["asset_id"] = asset_id if asset_id in visible else None
        # MySQL returns SUM(CASE ...) as DECIMAL and the JSON encoder emits it
        # as a string. All counters are integers in the public trends contract.
        for counter in ("successful", "failed", "cancelled", "entered", "timed", "linked", "rounds", "negative"):
            row[counter] = int(row[counter])
        row["active_seconds"] = float(row["active_seconds"] or 0)
        row["tokens"] = int(row["tokens"]) if row["tokens"] is not None else None
        row["output_day"] = str(row["output_day"]) if row["output_day"] else None
        group["rows"].append(row)
    return {"months": [groups[i] for i in range(1, month + 1)], "year": groups[0], "last90": groups[-1]}
