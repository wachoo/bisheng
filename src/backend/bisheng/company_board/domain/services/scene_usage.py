from collections import defaultdict
from datetime import date, datetime, time, timedelta

from bisheng.company_board.domain.repositories.scene_usage import scene_inputs
from bisheng.company_board.domain.repositories.supplement import list_supplements


def feedback_rate(r, key):
    return 1 - r[key + "_negative"] / r[key] if r[key] and r[key + "_linked"] == r[key] else None


def reconcile_scenes(entries, reused, events, year_start, month_start, trailing, cutoff):
    topics = {r.id: r.name for r in entries if r.kind == "topic"}
    scenes = {r.id: r for r in entries if r.kind == "scene" and r.effective_date and r.effective_date <= cutoff}
    mappings = defaultdict(list)
    for row in entries:
        if row.kind == "release" and row.parent_id in scenes and row.asset_key and row.effective_date:
            mappings[row.asset_key].append((row.parent_id, row.effective_date, None))
    for row in reused:
        if row["parent_id"] in scenes and row["date"]:
            expiry = row["fields"].get("end")
            mappings[row["fields"]["asset"]].append(
                (row["parent_id"], row["date"], date.fromisoformat(expiry) if expiry else None)
            )
    assets = defaultdict(set)
    for key, history in mappings.items():
        for sid, begin, expiry in history:
            if begin <= cutoff and (expiry is None or expiry >= cutoff):
                assets[sid].add(key)
    totals = {}
    for day, asset, status, count, timed, seconds, linked, negative in events:
        day = date.fromisoformat(day) if isinstance(day, str) else day
        if isinstance(day, datetime):
            day = day.date()
        candidates = {
            sid
            for sid, begin, expiry in mappings["assistant:" + str(asset)]
            if max(scenes[sid].effective_date, begin) <= day and (expiry is None or day <= expiry)
        }
        # A published employee can serve several scenarios. A shared run without an explicit scene
        # is retained in company totals but cannot be counted as successful work for each scene.
        if len(candidates) != 1:
            continue
        (sid,) = candidates
        record = totals.setdefault(sid, defaultdict(int))
        if day >= month_start:
            record["month_timed"] += timed
            record["month_seconds"] += float(seconds or 0)
        if status != "success":
            continue
        record["last_used"] = max(record.get("last_used", day), day)
        for window, start in (("year", year_start), ("month", month_start), ("last90", trailing)):
            if day >= start:
                record[window] += count
                record[window + "_linked"] += linked
                record[window + "_negative"] += negative
    result = []
    for sid, r in totals.items():
        scene = scenes[sid]

        result.append(
            {
                "id": sid,
                "asset_ids": sorted(assets[sid]),
                "name": scene.name,
                "topic": scene.parent_id,
                "topic_name": topics.get(scene.parent_id),
                "department_id": scene.department_id,
                "launched": scene.effective_date,
                "year": r["year"],
                "month": r["month"],
                "last90": r["last90"],
                "last_used": r.get("last_used"),
                "month_hours": r["month_seconds"] / 3600 if r["month_timed"] else None,
                "month_timed_seconds": r["month_seconds"],
                "month_linked": r["month_linked"],
                "month_negative": r["month_negative"],
                "positive_rate": feedback_rate(r, "last90"),
                "month_positive_rate": feedback_rate(r, "month"),
            }
        )
    return result


async def read_scenes(tenant, month_start, end, monthly_only=False):
    cutoff = (end - timedelta(microseconds=1)).date()
    year = date(month_start.year, 1, 1)
    trailing = cutoff - timedelta(days=89)
    start = month_start if monthly_only else datetime.combine(min(year, trailing), time.min)
    entries, events = await scene_inputs(tenant, start - timedelta(hours=8), end - timedelta(hours=8))
    links = await list_supplements(tenant, cutoff, ["scene-asset"])
    rows = reconcile_scenes(entries, links, events, year, month_start.date(), trailing, cutoff)
    if monthly_only:
        fields = {
            "id",
            "name",
            "topic",
            "topic_name",
            "department_id",
            "asset_ids",
            "month",
            "month_linked",
            "month_negative",
            "month_positive_rate",
            "month_hours",
        }
        return [{k: v for k, v in row.items() if k in fields} for row in rows]
    return rows
