from datetime import date

from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.ledger import list_ledger
from bisheng.company_board.domain.repositories.planning import plan_cutoff, read_plan, save_plan, support_is_current
from bisheng.company_board.domain.repositories.asset_context import options_from_rows
from bisheng.company_board.domain.repositories.scene_links import legacy_scene_assets
from bisheng.company_board.domain.schemas.planning import Scene
from bisheng.company_board.domain.services.knowledge_progress import knowledge_progress
from bisheng.company_board.domain.services.boards import require_access, tenant_for


async def plan_for(user, year):
    await require_access(user, "manage")
    tenant = tenant_for(user)
    plan = await read_plan(tenant, year)
    departments, assets = await load_catalog(tenant)
    cutoff = plan_cutoff(year)
    ledger = await list_ledger(tenant, year, cutoff)
    scenes = [r for r in plan["items"] if r["kind"] == "scene"]
    if any("asset_keys" not in r for r in scenes):
        legacy = await legacy_scene_assets(tenant, cutoff, ledger, assets)
        for r in scenes:
            r.setdefault("asset_keys", sorted(legacy.get(r["id"], ())))
    for r in scenes:
        day = max(date(year, 1, 1), cutoff)
        r["support_department_ids"] = sorted({
            s["department"] for s in r["supports"]
            if support_is_current(s["start"], s["end"], day)
        })
    built = {
        r["asset_key"]
        for r in ledger
        if r["kind"] == "release"
        and r.get("asset_key")
        and r["asset_key"].startswith(("assistant:", "flow:", "app:"))
        and r["effective_date"]
        and date(year, 1, 1) <= r["effective_date"] <= cutoff
    }
    return {
        **plan,
        "built": len(built),
        "departments": departments,
        "assets": [{k: a[k] for k in ("id", "kind", "name")} for a in assets],
        "knowledge_progress": await knowledge_progress(tenant, year, cutoff),
        "default_topic": options_from_rows(tenant, year, ledger)["default_topic"],
    }


async def update_plan(user, year, edit):
    await require_access(user, "manage")
    tenant = tenant_for(user)
    available, inherited = set(), set()
    if isinstance(edit, Scene) and edit.asset_keys is not None:
        _, assets = await load_catalog(tenant)
        available = {a["id"] for a in assets}
        if edit.id:
            cutoff = plan_cutoff(year)
            ledger = await list_ledger(tenant, year, cutoff)
            legacy = await legacy_scene_assets(tenant, cutoff, ledger, assets)
            inherited = legacy.get(str(edit.id), set())
    await save_plan(tenant, user.user_id, year, edit, available_assets=available, inherited_assets=inherited)
