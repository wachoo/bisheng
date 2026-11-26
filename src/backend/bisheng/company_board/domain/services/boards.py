from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.errcode.company_board import BoardLedgerInvalidError
from bisheng.common.errcode.http_error import UnAuthorizedError
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories.feedback import satisfaction
from bisheng.company_board.domain.repositories.ledger import list_ledger, release_departments, save_ledger
from bisheng.company_board.domain.schemas.ledger import BoardKind, LedgerInput
from bisheng.core.context.tenant import get_current_tenant_id, strict_tenant_filter
from bisheng.database.models.role_access import WebMenuResource
from bisheng.user.domain.models.user import UserDao


def tenant_for(user: UserPayload) -> int:
    return get_current_tenant_id() or user.tenant_id


async def board_access(user: UserPayload) -> dict[str, bool]:
    if user.is_admin() or user.is_global_super:
        return {"lead": True, "monitor": True, "manage": True, "resolve": True}
    with strict_tenant_filter():
        identity = await UserDao.aget_user(user.user_id)
        if not identity:
            raise UnAuthorizedError.http_exception()
        _, menus = await user.get_roles_web_menu(identity)
    monitor = WebMenuResource.COMPANY_MONITORBOARD.value in menus
    return {
        "lead": WebMenuResource.COMPANY_LEADBOARD.value in menus,
        "monitor": monitor,
        "manage": monitor and WebMenuResource.COMPANY_BOARD_LEDGER.value in menus,
        "resolve": monitor and WebMenuResource.COMPANY_BOARD_FEEDBACK.value in menus,
    }


async def require_access(user: UserPayload, action: Literal["lead", "monitor", "manage", "resolve"]) -> dict[str, bool]:
    access = await board_access(user)
    if not access[action]:
        raise UnAuthorizedError.http_exception()
    return access


def reporting_period(year: int, month: int | None, now: datetime) -> tuple[datetime, datetime]:
    start = datetime(year, month or 1, 1)
    end = datetime(year, month + 1, 1) if month and month < 12 else datetime(year + 1, 1, 1)
    return start, min(end, now)


def strategic_totals(rows: list[dict], year: int, cutoff: date) -> dict:
    goals = {r["indicator"]: r["target"] for r in rows if r["kind"] == "goal"}
    reached = [
        r for r in rows if r["effective_date"] and r["effective_date"].year == year and r["effective_date"] <= cutoff
    ]
    active_topics = {r["id"] for r in rows if r["kind"] == "topic"}
    planned_scenes = {r["id"] for r in rows if r["kind"] == "scene" and r["parent_id"] in active_topics}
    collections = {r["id"] for r in rows if r["kind"] == "collection" and r["parent_id"] in active_topics}
    return {
        "employee_built": len(
            {
                r["asset_key"]
                for r in reached
                if r["kind"] == "release"
                and r["parent_id"] in planned_scenes
                and r["asset_key"].split(":", 1)[0] in {"assistant", "flow", "app"}
            }
        ),
        "scene_launched": len({r["id"] for r in reached if r["id"] in planned_scenes}),
        "knowledge_verified": len({r["id"] for r in reached if r["id"] in collections}),
        "employee_target": goals.get("employee"),
        "scene_target": goals.get("scene"),
        "knowledge_target": goals.get("knowledge"),
        "knowledge_planned": len(collections),
    }


async def overview(user: UserPayload, board: BoardKind, year: int, month: int | None) -> dict:
    from bisheng.company_board.domain.services.runtime import read_runtime

    access = await require_access(user, board)
    tenant_id = tenant_for(user)
    now = datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    start, end = reporting_period(year, month, now)
    # End is exclusive. For a completed month Jan 1 00:00 belongs to the next report.
    cutoff = (end - timedelta(microseconds=1)).date()
    departments, assets = await load_catalog(tenant_id)
    rows = await list_ledger(tenant_id, year, cutoff) if board == "lead" or access["manage"] else []
    first_publishers = await release_departments(tenant_id, cutoff)
    for asset in assets:
        asset["department_id"] = first_publishers.get(asset["id"])
    runtime = await read_runtime(tenant_id, start, end)
    # No prompts, file contents or private feedback are returned to the company aggregate.
    visible_assets = {a["id"] for a in assets}
    runtime["usage"] = [item for item in runtime["usage"] if item["asset_id"] in visible_assets]
    runtime["detail_access"] = access["resolve"] or access["manage"]
    if not runtime["detail_access"]:
        runtime["recent_runs"] = []
    return {
        "year": year,
        "month": month,
        "cutoff": cutoff,
        "catalog_as_of": now.date(),
        "departments": departments,
        "assets": assets,
        "ledger": rows,
        "strategy": strategic_totals(rows, year, cutoff) if board == "lead" else None,
        "runtime": runtime,
        "satisfaction": await satisfaction(tenant_id, start - timedelta(hours=8), end - timedelta(hours=8)) if board == "lead" else None,
    }


async def ledger_for(user: UserPayload, year: int):
    await require_access(user, "manage")
    return await list_ledger(tenant_for(user), year)


async def record_entry(user: UserPayload, data: LedgerInput, entry_id: str | None = None, revision: int = 0):
    await require_access(user, "manage")
    if data.kind == "goal" and data.indicator == "knowledge":
        raise BoardLedgerInvalidError(msg="知识集目标由计划清单去重计算。历史数值目标仅供查阅。")
    tenant_id = tenant_for(user)
    if data.asset_key:
        _, assets = await load_catalog(tenant_id)
        if not any(
            a["id"] == data.asset_key and (data.kind != "collection" or a["kind"] == "knowledge") for a in assets
        ):
            raise BoardLedgerInvalidError(msg="所选资产不在当前租户的有效目录内")
    return await save_ledger(tenant_id, user.user_id, data, entry_id, revision)
