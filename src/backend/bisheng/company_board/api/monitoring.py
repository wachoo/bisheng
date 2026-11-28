from typing import Literal

from fastapi import APIRouter, Depends, Query

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.schemas.ledger import BoardKind
from bisheng.company_board.domain.services import monitoring

router = APIRouter()
AssetFilter = Literal["", "employee", "knowledge", "tool"]


@router.get("/monitoring")
async def monitoring_view(
    board: BoardKind,
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    topic: str = Query("", max_length=36),
    scene: str = Query("", max_length=36),
    department: str = Query("", max_length=16),
    kind: AssetFilter = "",
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(await monitoring.read_monitoring(user, board, year, month, topic, scene, department, kind))


@router.get("/monitoring/feedback")
async def issues(
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    topic: str = Query("", max_length=36),
    scene: str = Query("", max_length=36),
    department: str = Query("", max_length=16),
    kind: AssetFilter = "",
    stage: Literal["pending", "closed"] = "pending",
    search: str = Query("", max_length=160),
    run_id: str = Query("", max_length=32),
    offset: int = Query(0, ge=0),
    limit: int = Query(12, ge=1, le=50),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(
        await monitoring.read_issues(
            user, year, month, topic, scene, department, kind, stage, search.strip(), run_id, offset, limit
        )
    )


@router.get("/monitoring/runs/{run_id}")
async def run_receipt(
    run_id: str,
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(await monitoring.read_run(user, run_id, year, month))
