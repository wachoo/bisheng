"""Scenario-managed asset selections supersede historical asset-side assignments."""

import json
from collections import defaultdict

from sqlalchemy import and_, func
from sqlmodel import select

from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.asset_context import first_binding_dates
from bisheng.company_board.domain.repositories.supplement import list_supplements
from bisheng.core.database import get_async_db_session

SCENE_LINKS = "scene-links"


async def managed_scene_assets(tenant, cutoff):
    row = BoardSupplement
    latest = select(row.id, func.max(row.revision).label("rev")).where(
        row.tenant_id == tenant, row.kind == SCENE_LINKS,
    )
    if cutoff is not None:
        latest = latest.where(row.business_date <= cutoff)
    latest = latest.group_by(row.id).subquery()
    stmt = (
        select(row.parent_id, row.payload)
        .join(latest, and_(latest.c.id == row.id, latest.c.rev == row.revision))
        .where(row.tenant_id == tenant, row.kind == SCENE_LINKS)
    )
    async with get_async_db_session() as db:
        return {scene: json.loads(payload)["assets"] for scene, payload in (await db.exec(stmt)).all()}


async def legacy_scene_links(tenant, cutoff):
    """Read asset-side links and the scene memberships embedded in historical cases."""
    rows = await list_supplements(tenant, cutoff, ["scene-asset", "case"])
    links = []
    for row in rows:
        if row["kind"] == "scene-asset":
            links.append(row)
        elif row["kind"] == "case" and row["fields"].get("scene"):
            asset_list = row["fields"].get("assets") or ""
            keys = {key.strip() for key in asset_list.split(",") if key.strip()}
            for key in sorted(keys):
                links.append({
                    "kind": "scene-asset",
                    "source": "case",
                    "parent_id": row["fields"]["scene"],
                    "date": row["date"],
                    "fields": {"asset": key},
                })
    return links


async def legacy_scene_assets(tenant, cutoff, ledger, assets):
    """Effective legacy links for the plan being edited, before scene-level takeover."""
    result = defaultdict(set)
    edits = await first_binding_dates(tenant, cutoff)
    context_keys = {asset["id"]: asset.get("context_key") or asset["id"] for asset in assets}
    for row in ledger:
        if row["kind"] != "release" or not row["parent_id"] or not row["asset_key"]:
            continue
        key = row["asset_key"]
        if row["effective_date"] and row["effective_date"] <= cutoff and context_keys.get(key, key) not in edits:
            result[row["parent_id"]].add(key)
    for link in await legacy_scene_links(tenant, cutoff):
        end = link["fields"].get("end")
        if not end or end >= cutoff.isoformat():
            result[link["parent_id"]].add(link["fields"]["asset"])
    return result
