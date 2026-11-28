from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, StringConstraints

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.services import feedback

router = APIRouter()


class Resolution(BaseModel):
    measure: Annotated[str, StringConstraints(strip_whitespace=True)] = Field(min_length=1, max_length=500)


@router.get("/feedback")
async def snapshot(
    year: int = Query(ge=2000, le=2100),
    month: int = Query(0, ge=0, le=12),
    offset: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=100),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(await feedback.snapshot(user, year, month, offset, limit))


@router.put("/feedback/{run_id}/resolution")
async def resolve(run_id: str, data: Resolution, user: UserPayload = Depends(UserPayload.get_login_user)):
    await feedback.close(user, run_id, data.measure)
    return resp_200()
