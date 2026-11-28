from fastapi import APIRouter, Depends, Query

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.schemas.ledger import BoardKind
from bisheng.company_board.domain.services.activity_trends import read_trends

router = APIRouter()


@router.get("/trends")
async def trends(
    board: BoardKind,
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(await read_trends(user, board, year, month))
