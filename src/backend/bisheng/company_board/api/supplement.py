from typing import Literal

from fastapi import APIRouter, Depends, Query

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.schemas.supplement import SupplementInput
from bisheng.company_board.domain.services import supplement

router = APIRouter()


@router.get("/registers")
async def registers(
    board: Literal["lead", "monitor", "manage"],
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(await supplement.read(user, board, year, month))


@router.put("/registers")
async def record(data: SupplementInput, user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await supplement.save(user, data))
