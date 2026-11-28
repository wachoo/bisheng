from typing import Annotated

from fastapi import APIRouter, Depends, Path

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.schemas.planning import PlanEdit
from bisheng.company_board.domain.services.planning import plan_for, update_plan

router = APIRouter()
PlanYear = Annotated[int, Path(ge=2000, le=2100)]


@router.get("/planning/{year}")
async def get_plan(year: PlanYear, user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await plan_for(user, year))


@router.put("/planning/{year}")
async def change_plan(year: PlanYear, body: PlanEdit, user: UserPayload = Depends(UserPayload.get_login_user)):
    await update_plan(user, year, body)
    return resp_200()
