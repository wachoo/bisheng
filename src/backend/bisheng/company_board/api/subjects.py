from typing import Literal

from fastapi import APIRouter, Depends, Query

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.schemas.ledger import BoardKind
from bisheng.company_board.domain.services.subjects import read_asset_activity

router = APIRouter()


@router.get("/asset-activity")
async def read_asset(
    board: BoardKind,
    asset: str = Query(min_length=3, max_length=128),
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    window: Literal["month", "year", "90"] = "month",
    department: str = Query("", pattern=r"^(?:[0-9]{1,15}|unassigned)?$"),
    status: Literal["", "success", "failed", "cancelled"] = "",
    search: str = Query("", max_length=64),
    page: int = Query(1, ge=1, le=1000000),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(
        await read_asset_activity(user, board, asset, year, month, window, department, status, search, page)
    )
