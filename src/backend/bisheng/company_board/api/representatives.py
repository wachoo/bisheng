from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.api.planning import PlanYear
from bisheng.company_board.domain.services.representatives import options_for, save_for


class Selection(BaseModel):
    asset: str | None = Field(max_length=96)
    revision: int = Field(ge=0)


router = APIRouter()


@router.get("/planning/{year}/representatives")
async def get_representatives(year: PlanYear, user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await options_for(user, year))


@router.put("/planning/{year}/representatives/{topic}")
async def set_representative(year: PlanYear, topic: UUID, body: Selection,
                             user: UserPayload = Depends(UserPayload.get_login_user)):
    await save_for(user, year, str(topic), body.asset, body.revision)
    return resp_200()
