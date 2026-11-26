from collections import defaultdict
from datetime import date, datetime, time, timedelta

from bisheng.company_board.domain.repositories.asset_context import first_binding_dates
from bisheng.company_board.domain.repositories.scene_links import legacy_scene_links
from bisheng.company_board.domain.repositories.scene_usage import employee_service_counts, scene_inputs


def feedback_rate(r, key):
    return 1 - r[key + "_negative"] / r[key] if r[key] and r[key + "_linked"] == r[key] else None


def scene_relationships(entries, reused, first_edits, managed, cutoff):
    scenes = {r.id: r for r in entries if r.kind == "scene"}
    mappings = defaultdict(list)
    assets = defaultdict(set)
    for row in entries:
        if (
            row.kind == "release"
            and row.parent_id in scenes
            and row.parent_id not in managed
            and row.asset_key
            and row.effective_date
        ):
            transition = first_edits.get(row.asset_key)
            if transition is None or row.effective_date < transition:
                mappings[row.asset_key].append(
                    (row.parent_id, row.effective_date, transition - timedelta(days=1) if transition else None)
                )
    for row in reused:
        if row["parent_id"] in scenes and row["parent_id"] not in managed and row["date"]:
            expiry = row["fields"].get("end")
            end = date.fromisoformat(expiry) if expiry else None
            key = row["fields"]["asset"]
            if row.get("source") == "case":
                # A legacy case identifies employees linked to a scene, but does
                # not prove that any given historical request ran in that scene.
                if row["date"] <= cutoff and (end is None or end >= cutoff):
                    assets[row["parent_id"]].add(key)
            else:
                mappings[key].append((row["parent_id"], row["date"], end))
    for sid, keys in managed.items():
        if sid in scenes:
            for key in keys:
                mappings[key].append((sid, date(scenes[sid].year, 1, 1), None))
    for key, history in mappings.items():
        for sid, begin, expiry in history:
            if begin <= cutoff and (expiry is None or expiry >= cutoff):
                assets[sid].add(key)
    return mappings, assets


def reconcile_scenes(entries, mappings, assets, events, year_start, month_start, trailing, cutoff):
    topics = {r.id: r.name for r in entries if r.kind == "topic"}
    scenes = {r.id: r for r in entries if r.kind == "scene" and r.effective_date and r.effective_date <= cutoff}
    totals = {}
    for day, asset, status, count, timed, seconds, linked, negative in events:
        day = date.fromisoformat(day) if isinstance(day, str) else day
        if isinstance(day, datetime):
            day = day.date()
        candidates = {
            sid
            for sid, begin, expiry in mappings.get("assistant:" + str(asset), ())
            if sid in scenes and max(scenes[sid].effective_date, begin) <= day and (expiry is None or day <= expiry)
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


def service_employees(entries, scene_assets, catalog):
    names = {r.asset_key: r.name for r in entries if r.kind == "release" and r.asset_key}
    names.update({a["id"]: a["name"] for a in catalog if a["kind"] == "employee"})
    employees = {}
    for scene in sorted((r for r in entries if r.kind == "scene"), key=lambda r: (r.name, r.id)):
        for key in scene_assets.get(scene.id, ()):
            if not key.startswith(("assistant:", "flow:", "app:")):
                continue
            employee = employees.setdefault(
                key,
                {
                    "asset_id": key,
                    "name": names.get(key) or key,
                    "scenes": [],
                    "uses": 0,
                    "users": 0,
                    "monitored": False,
                },
            )
            employee["scenes"].append({"id": scene.id, "name": scene.name})
    return employees


async def annual_service(tenant, year, end, entries, scene_assets, catalog):
    employees = service_employees(entries, scene_assets, catalog)
    # Stored employee events currently originate only from the assistant entry point.
    assistant_ids = [key.removeprefix("assistant:") for key in employees if key.startswith("assistant:")]
    start = datetime.combine(year, time.min) - timedelta(hours=8)
    counts = await employee_service_counts(tenant, start, end - timedelta(hours=8), assistant_ids)
    uses = users = 0
    for asset, times, people in counts:
        if asset is None:
            uses, users = times, people
        else:
            employees["assistant:" + asset].update(uses=times, users=people, monitored=True)
    ordered = sorted(employees.values(), key=lambda row: (-row["uses"], row["name"], row["asset_id"]))
    return {"uses": uses, "users": users, "employees": ordered}


async def read_scene_report(tenant, month_start, end, managed, catalog, monthly_only=False):
    cutoff = (end - timedelta(microseconds=1)).date()
    year = date(month_start.year, 1, 1)
    trailing = cutoff - timedelta(days=89)
    start = month_start if monthly_only else datetime.combine(min(year, trailing), time.min)
    entries, events = await scene_inputs(tenant, start - timedelta(hours=8), end - timedelta(hours=8))
    links = await legacy_scene_links(tenant, cutoff)
    first_edits = await first_binding_dates(tenant, cutoff)
    if any(key.startswith("toolset:") for key in first_edits):
        first_edits.update(
            {a["id"]: first_edits[a["context_key"]] for a in catalog if a.get("context_key") in first_edits}
        )
    mappings, assets = scene_relationships(entries, links, first_edits, managed, cutoff)
    rows = reconcile_scenes(entries, mappings, assets, events, year, month_start.date(), trailing, cutoff)
    current_links = {r.id: sorted(assets[r.id]) for r in entries if r.kind == "scene" and r.year <= year.year}
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
        return [{k: v for k, v in row.items() if k in fields} for row in rows], None, current_links
    return rows, await annual_service(tenant, year, end, entries, current_links, catalog), current_links
