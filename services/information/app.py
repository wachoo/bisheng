"""BiSheng Information protocol and the internal source administration application."""

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from secrets import compare_digest
from threading import BoundedSemaphore
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from feeds import SOURCES, collect
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from scheduler import Scheduler
from store import Store

ASSETS = Path(__file__).with_name("admin")
basic = HTTPBasic(auto_error=False)
PUBLIC_FIELDS = {
    "id",
    "source_id",
    "business_type",
    "name",
    "description",
    "original_url",
    "icon",
    "follow_num",
}


class SourceIDs(BaseModel):
    information_ids: list[str] = Field(max_length=1000)


class SourceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: StrictBool | None = None
    interval_seconds: int | None = Field(default=None, ge=60, le=604800)


def public(row):
    return {key: value for key, value in row.items() if key in PUBLIC_FIELDS}


def paginated(items, page, size):
    offset = (page - 1) * size
    return {
        "code": 200,
        "data": items[offset : offset + size],
        "totalCount": len(items),
        "currentPage": page,
        "PageSize": size,
    }


def create_app(
    store, keys, admin_password, *, sources=SOURCES, collector=collect, schedule=True
):
    if (
        not isinstance(keys, dict)
        or not keys
        or any(
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(key, str)
            or not key.strip()
            for name, key in keys.items()
        )
    ):
        raise ValueError(
            "INFORMATION_API_KEYS must map nonempty caller names to credentials"
        )
    if (
        len(set(keys.values())) != len(keys)
        or not admin_password
        or admin_password in keys.values()
    ):
        raise ValueError("Each caller and the administrator need a separate credential")
    credentials = [(name, key.encode()) for name, key in keys.items()]
    admin_secret = admin_password.encode()
    runner = Scheduler(store, sources, collector)
    previews = {key: BoundedSemaphore(1) for key in sources}

    @asynccontextmanager
    async def lifespan(_):
        if schedule:
            runner.start()
        try:
            yield
        finally:
            runner.stop()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def caller(x_api_key: str = Header(default="")):
        supplied = x_api_key.encode()
        for name, secret in credentials:
            if compare_digest(secret, supplied):
                return name
        raise HTTPException(401, "Invalid API key")

    def administrator(auth: Annotated[HTTPBasicCredentials | None, Depends(basic)]):
        if (
            not auth
            or auth.username != "admin"
            or not compare_digest(auth.password.encode(), admin_secret)
        ):
            raise HTTPException(
                401,
                "需要管理员身份",
                headers={"WWW-Authenticate": 'Basic realm="Information"'},
            )

    def mutation(x_admin_request: str = Header(default="")):
        if x_admin_request != "1":
            raise HTTPException(403, "请求缺少管理操作标识")

    def known(source_id: str):
        if source_id not in sources:
            raise HTTPException(404, "信息源不存在")
        return source_id

    def valid_ids(body: SourceIDs):
        for source_id in body.information_ids:
            known(source_id)
        return list(dict.fromkeys(body.information_ids))

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        if request.url.path.startswith("/information/") and exc.status_code == 401:
            # BiSheng checks protocol errors after it has accepted HTTP status 200.
            return JSONResponse({"code": 401, "message": exc.detail})
        return JSONResponse(
            {"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers
        )

    @app.get("/health")
    def health():
        return {"status": "ok"}

    api = APIRouter(prefix="/information", dependencies=[Depends(caller)])

    @api.get("/list")
    @api.get("/search")
    def catalogue(
        keyword: str = "",
        business_type: str | None = None,
        page: int = Query(1, ge=1, le=1000000),
        page_size: int = Query(20, ge=1, le=1000),
    ):
        rows = [
            public(s)
            for s in sources.values()
            if (not business_type or s["business_type"] == business_type)
            and keyword.casefold()
            in " ".join(
                str(s.get(k, "")) for k in ("name", "description", "original_url")
            ).casefold()
        ]
        return paginated(rows, page, page_size)

    @api.post("/source_by_ids")
    def by_ids(ids: Annotated[list[str], Depends(valid_ids)]):
        return {"code": 200, "data": [public(sources[i]) for i in ids]}

    @api.post("/subscribe")
    def subscribe(
        principal: Annotated[str, Depends(caller)],
        ids: Annotated[list[str], Depends(valid_ids)],
    ):
        store.subscribe(principal, ids, True)
        return {"code": 200}

    @api.post("/unsubscribe")
    def unsubscribe(
        principal: Annotated[str, Depends(caller)],
        ids: Annotated[list[str], Depends(valid_ids)],
    ):
        store.subscribe(principal, ids, False)
        return {"code": 200}

    @api.get("/subscriptions")
    def subscriptions(
        principal: Annotated[str, Depends(caller)],
        page: int = Query(1, ge=1, le=1000000),
        page_size: int = Query(100, ge=1, le=1000),
    ):
        return paginated(store.subscriptions(principal), page, page_size)

    def article_page(source_id, page, size, include_source=False, **bounds):
        articles, total, snapshot = store.page(
            source_id, page=page, page_size=size, **bounds
        )
        data = {"articles": articles, "snapshot_max_create_time": snapshot}
        if include_source:
            data["information"] = public(sources[source_id])
        return {
            "code": 200,
            "data": data,
            "currentPage": page,
            "PageSize": size,
            "totalCount": total,
        }

    @api.get("/articles/{source_id}/bootstrap")
    def bootstrap(
        source_id: str = Depends(known), limit: int = Query(36, ge=1, le=1000)
    ):
        return article_page(source_id, 1, limit, bootstrap=True)

    @api.get("/articles/{source_id}")
    def articles(
        source_id: str = Depends(known),
        page: int = Query(1, ge=1, le=1000000),
        page_size: int = Query(20, ge=1, le=1000),
        min_create_time: int | None = Query(None, ge=0, le=2**63 - 1),
        max_create_time: int | None = Query(None, ge=0, le=2**63 - 1),
        return_information: bool = False,
    ):
        return article_page(
            source_id,
            page,
            page_size,
            return_information,
            min_create_time=min_create_time,
            max_create_time=max_create_time,
        )

    admin = APIRouter(prefix="/admin", dependencies=[Depends(administrator)])

    @admin.get("/sources")
    @admin.get("/sources/{source_id}")
    def screen(source_id: str | None = None):
        if source_id:
            known(source_id)
        return FileResponse(
            ASSETS / "index.html", headers={"Cache-Control": "no-store"}
        )

    @admin.get("/static/{asset}")
    def static(asset: str):
        if asset not in {"admin.css", "admin.js"}:
            raise HTTPException(404)
        return FileResponse(ASSETS / asset)

    @admin.get("/api/sources")
    def statuses():
        return store.statuses()

    @admin.get("/api/sources/{source_id}")
    def status(source_id: str = Depends(known)):
        return dict(runner.status(source_id), runs=store.recent_runs(source_id))

    @admin.patch("/api/sources/{source_id}", dependencies=[Depends(mutation)])
    def configure(config: SourceConfig, source_id: str = Depends(known)):
        changes = config.model_dump(exclude_none=True)
        if not changes:
            raise HTTPException(422, "请指定采集周期或启停状态")
        runner.configure(source_id, **changes)
        return status(source_id)

    @admin.post("/api/sources/{source_id}/preview", dependencies=[Depends(mutation)])
    def preview(source_id: str = Depends(known)):
        lock = previews[source_id]
        if not lock.acquire(blocking=False):
            raise HTTPException(409, "该来源正在试采")
        try:
            return runner.preview(source_id)
        except (OSError, ValueError, RuntimeError) as exc:
            raise HTTPException(502, f"试采失败：{exc}") from exc
        finally:
            lock.release()

    app.include_router(api)
    app.include_router(admin)
    return app


def from_environment():
    path = Path(os.environ.get("INFORMATION_DB", "./data/information.sqlite3"))
    path.parent.mkdir(parents=True, exist_ok=True)
    return create_app(
        Store(path, SOURCES),
        json.loads(os.environ["INFORMATION_API_KEYS"]),
        os.environ["INFORMATION_ADMIN_PASSWORD"],
    )
