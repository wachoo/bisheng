from typing import Literal

from fastapi import APIRouter, Depends, Query

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.schemas.research_report import ResearchReportInput
from bisheng.company_board.domain.services.research_report import read_report, write_report

router = APIRouter()


@router.get("/research-report")
async def get_research_report(
    board: Literal["lead", "manage"],
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(await read_report(user, board, year, month))


@router.put("/research-report")
async def put_research_report(body: ResearchReportInput, user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await write_report(user, body))
