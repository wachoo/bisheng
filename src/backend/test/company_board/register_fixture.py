"""Acceptance API for registers.cjs, with a fresh in-memory SQLite database on each start.

Launch in the backend image on loopback port 17862 with an empty config.yaml and
PYTHONPATH=/app/test/company_board:/app. Run uvicorn register_fixture:app inside
the disposable container. It does not need the development Compose network or volumes.
"""

from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace

from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.company_board.api.router import router
from bisheng.company_board.domain.models.feedback import BoardIssueResolution, BoardRating
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.database.models.audit_log import AuditLog
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.database.models.department import Department
from bisheng.knowledge.domain.models.knowledge import Knowledge

engine = create_async_engine("sqlite+aiosqlite://")


@asynccontextmanager
async def session():
    async with AsyncSession(engine, expire_on_commit=False) as db:
        yield db


async def catalog(_tenant):
    return (
        [{"id": i, "name": name} for i, name in enumerate(("验证部门", "支持单位甲", "支持单位乙"), 1)],
        [{"id":"assistant:2","kind":"employee","name":"验证备选员工","department_id":None}] + [
            {"id": prefix + ":1", "kind": kind, "department_id": None, "name": "验证" + name}
            for kind, prefix, name in [
                ("employee", "assistant", "员工"),
                ("knowledge", "knowledge", "知识库"),
                ("skill", "skill", "技能"),
                ("tool", "tool", "工具"),
            ]
        ],
    )


@asynccontextmanager
async def lifespan(_app):
    import importlib
    import pkgutil
    import sys
    from bisheng.company_board.domain import repositories

    for item in pkgutil.iter_modules(repositories.__path__):
        importlib.import_module(f"{repositories.__name__}.{item.name}")

    from bisheng.company_board.domain.services import asset_context
    importlib.import_module("bisheng.company_board.domain.services.knowledge_progress")

    async def fixture_edit(user, *, resource_type, resource_id, action):
        assert user.user_id == 9 and resource_type == "knowledge_library" and resource_id == 1 and action == "edit"

    asset_context.require_business_action = fixture_edit
    for module in tuple(sys.modules.values()):
        if not getattr(module, "__name__", "").startswith("bisheng.company_board."):
            continue
        if hasattr(module, "get_async_db_session"):
            module.get_async_db_session = session
        if hasattr(module, "load_catalog"):
            module.load_catalog = catalog
    async with engine.begin() as conn:
        for model in (BoardLedger, BoardRuntimeEvent, BoardRating, BoardIssueResolution, BoardSupplement, Department, AuditLog, Knowledge):
            await conn.run_sync(model.__table__.create)
    async with session() as db:
        db.add(Knowledge(id=1, name="验证知识库", user_id=9, tenant_id=1, type=0))
        db.add(Department(id=80, dept_id="fixture-org", name="组织根节点", tenant_id=1))
        db.add(Department(id=81, dept_id="fixture-company", name="葛洲坝供应链公司", tenant_id=1, parent_id=80))
        db.add(Department(id=82, dept_id="fixture-leaf", name="部门下属业务组", tenant_id=1, parent_id=1))
        for idx, name in enumerate(("验证部门", "支持单位甲", "支持单位乙"), 1):
            db.add(Department(id=idx, dept_id=f"fixture-{idx}", name=name, tenant_id=1, parent_id=81))
        db.add(
            BoardRuntimeEvent(
                id="sample",
                run_id="sample",
                user_id=9,
                department_id=1,
                tenant_id=1,
                kind="employee",
                asset_id="1",
                status="success",
                active_seconds=600,
                terminal_message_id=17,
                occurred_at=datetime(2026, 5, 6),
            )
        )
        await db.commit()
    yield
    await engine.dispose()


app = FastAPI(lifespan=lifespan)
app.include_router(router, prefix="/api/v1")
app.dependency_overrides[UserPayload.get_login_user] = lambda: SimpleNamespace(
    user_id=9, tenant_id=1, is_admin=lambda: True, is_global_super=False
)
