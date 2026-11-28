from fastapi import APIRouter, Depends, Query

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.schemas.ledger import BoardKind, LedgerEdit, LedgerInput
from bisheng.company_board.domain.services.boards import board_access, board_request_scope, ledger_for, overview, record_entry

from .asset_context import router as asset_context_router
from .planning import router as planning_router
from .representatives import router as representatives_router
from .research_report import router as research_report_router
from .feedback import router as feedback_router
from .monitoring import router as monitoring_router
from .subjects import router as subjects_router
from .supplement import router as supplement_router
from .trends import router as trends_router

router = APIRouter(prefix="/company-boards", tags=["Company boards"], dependencies=[Depends(board_request_scope)])
router.include_router(asset_context_router)
router.include_router(planning_router)
router.include_router(representatives_router)
router.include_router(research_report_router)
router.include_router(feedback_router)
router.include_router(monitoring_router)
router.include_router(subjects_router)
router.include_router(supplement_router)
router.include_router(trends_router)


@router.get("/access")
async def get_access(user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await board_access(user))


@router.get("/overview")
async def get_overview(
    board: BoardKind,
    year: int = Query(ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    user: UserPayload = Depends(UserPayload.get_login_user),
):
    return resp_200(await overview(user, board, year, month))


@router.get("/ledger")
async def get_ledger(year: int = Query(ge=2000, le=2100), user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await ledger_for(user, year))


@router.post("/ledger")
async def create_entry(body: LedgerInput, user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await record_entry(user, body))


@router.put("/ledger/{entry_id}")
async def edit_entry(entry_id: str, body: LedgerEdit, user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await record_entry(user, body, entry_id, body.revision))
