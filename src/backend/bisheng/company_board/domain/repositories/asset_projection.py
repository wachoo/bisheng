"""Translate current published asset metadata to the dashboard's case and scene rows."""

import json
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from bisheng.company_board.domain.repositories.asset_context import binding_history, binding_options, effective_topic
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.ledger import list_ledger


async def project_asset_rows(tenant, cutoff, kinds, records, bindings):
    day = cutoff or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    plans = await list_ledger(tenant, day.year, cutoff)
    opts = await binding_options(tenant, day.year, plans, day)
    _, assets = await load_catalog(tenant)
    by_key = defaultdict(list)
    for asset in assets:
        by_key[asset.get("context_key") or asset["id"]].append(asset["id"])
    history = await binding_history(tenant, day) if not kinds or "scene-asset" in kinds else []
    return project(bindings, opts, by_key, records, kinds, history)


def scene_intervals(history):
    # Revisions taking effect on the same reporting day have one final business state.
    days = defaultdict(dict)
    for row in history:
        days[row.parent_id][row.business_date] = row
    for key, snapshots in days.items():
        active = {}
        for day, row in sorted(snapshots.items()):
            current = set(json.loads(row.payload)["scenes"])
            for scene in active.keys() - current:
                yield key, scene, active.pop(scene), day - timedelta(days=1)
            for scene in current - active.keys():
                active[scene] = row
        for scene, first in active.items():
            yield key, scene, first, None


def project(bindings, options, by_key, records, kinds, history):
    result = []
    edited = {asset for b in bindings for asset in by_key.get(b.parent_id, [])}
    profiled = {asset for b in bindings if "profile" in json.loads(b.payload) for asset in by_key.get(b.parent_id, [])}
    first_edit = {}
    for row in history:
        for key in by_key.get(row.parent_id, ()):
            first_edit.setdefault(key, row.business_date)
    for row in records:
        if row["kind"] == "asset-profile" and row["parent_id"] in profiled:
            continue
        if row["kind"] == "scene-asset" and row["fields"].get("asset") in first_edit:
            transition = first_edit[row["fields"]["asset"]]
            if transition <= row["date"]:
                continue
            last = (transition - timedelta(days=1)).isoformat()
            row = {**row, "fields": {**row["fields"], "end": min(row["fields"].get("end") or last, last)}}
        if row["kind"] == "case" and row["fields"].get("assets"):
            remaining = [s for s in row["fields"]["assets"].split(",") if s.strip() not in edited]
            if not remaining:
                continue
            row = {**row, "fields": {**row["fields"], "assets": ",".join(remaining)}}
        result.append(row)
    for binding in bindings:
        linked = by_key.get(binding.parent_id)
        if not linked:
            continue
        payload = json.loads(binding.payload)
        topic, _ = effective_topic(binding, options)
        base = {"year": options["year"], "date": binding.business_date, "revision": binding.revision}
        if payload.get("profile") and (not kinds or "asset-profile" in kinds):
            for asset in linked:
                result.append(
                    {
                        **base,
                        "id": f"{binding.id}:profile:{asset}",
                        "kind": "asset-profile",
                        "parent_id": asset,
                        "name": binding.name,
                        "fields": payload["profile"],
                    }
                )
        scenes = payload["scenes"]
        if payload["case_name"] and (not kinds or "case" in kinds):
            result.append(
                {
                    **base,
                    "id": binding.id,
                    "kind": "case",
                    "name": payload["case_name"],
                    "parent_id": topic,
                    "fields": {
                        **payload["case_fields"],
                        "assets": ",".join(linked),
                        "scene": scenes[0] if scenes else "",
                    },
                }
            )
    for key, scene, first, end in scene_intervals(history):
        for asset in by_key.get(key, ()):
            fields = {"asset": asset}
            if end:
                fields["end"] = end.isoformat()
            result.append(
                {
                    "id": f"{first.id}:{first.revision}:{scene}:{asset}",
                    "kind": "scene-asset",
                    "year": first.year,
                    "revision": first.revision,
                    "name": first.name,
                    "date": first.business_date,
                    "parent_id": scene,
                    "fields": fields,
                }
            )
    return result
