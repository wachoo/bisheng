from fastapi import APIRouter, Depends

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.schemas.api import resp_200
from bisheng.company_board.domain.services.asset_context import (
    AssetContextInput,
    options,
    read_asset_context,
    save_asset_context,
    today,
)
from bisheng.company_board.domain.services.boards import tenant_for

router = APIRouter(prefix="/asset-context")


@router.get("/options")
async def asset_context_options(user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await options(tenant_for(user), today().year))


@router.get("/{asset_key}")
async def asset_context_read(asset_key: str, user: UserPayload = Depends(UserPayload.get_login_user)):
    return resp_200(await read_asset_context(user, tenant_for(user), asset_key, today().year))


@router.put("/{asset_key}")
async def asset_context_write(
    asset_key: str, body: AssetContextInput, user: UserPayload = Depends(UserPayload.get_login_user)
):
    return resp_200(await save_asset_context(user, tenant_for(user), asset_key, body))
