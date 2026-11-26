import unittest
from contextlib import asynccontextmanager
from datetime import date, datetime
from unittest.mock import patch

from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import Session
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories import ledger
from bisheng.company_board.domain.repositories.catalog import load_catalog
from bisheng.company_board.domain.repositories import publication as pub
from bisheng.database.models.app import App, AppDao
from bisheng.database.models.assistant import Assistant, AssistantStatus
from bisheng.database.models.audit_log import AuditLog
from bisheng.database.models.department import Department, UserDepartment
from bisheng.database.models.flow import Flow, FlowStatus, FlowType
from bisheng.knowledge.domain.models.knowledge import (
    AuthTypeEnum,
    Knowledge,
    KnowledgeDao,
    KnowledgeState,
    KnowledgeTypeEnum,
)
from bisheng.linsight.domain.models.linsight_skill import LinsightSkill, LinsightSkillDao
from bisheng.tool.domain.models.gpts_tools import GptsTools, GptsToolsDao, GptsToolsType, GptsToolsTypeRead


class PublicationTest(unittest.IsolatedAsyncioTestCase):
    day = date(2026, 9, 20)

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as conn:
            for model in (
                BoardLedger,
                BoardSupplement,
                Department,
                UserDepartment,
                Assistant,
                Flow,
                Knowledge,
                GptsTools,
                GptsToolsType,
                LinsightSkill,
                App,
                AuditLog,
            ):
                await conn.run_sync(model.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        self.session = session
        self.enterContext(patch.object(ledger, "get_async_db_session", session))
        self.enterContext(patch.object(pub, "shanghai_today", return_value=self.day))
        self.enterContext(patch("bisheng.knowledge.domain.models.knowledge.get_async_db_session", session))
        self.enterContext(patch("bisheng.linsight.domain.models.linsight_skill.get_async_db_session", session))
        listeners = [
            (Session, "do_orm_execute", pub.after_catalog_update),
            (AuditLog, "after_insert", pub.legacy_audit_inserted),
        ]
        for model in pub._STATUS_FIELDS:
            listeners.extend([(model, "after_insert", pub.inserted), (model, "after_update", pub.changed)])
        for args in listeners:
            if not event.contains(*args):
                self.addCleanup(event.remove, *args)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_catalog_displays_mcp_title_without_changing_operation_identity(self):
        pub.install_publication_tracking()
        async with self.session() as db:
            db.add(GptsToolsType(id=7, name="询价服务", tenant_id=1))
            for ident, kind, extra in [
                (1, 2, '{"title":"物资询价","annotations":{"title":"旧标题"}}'),
                (2, 2, '{"annotations":{"title":"批量询价"}}'),
                (3, 2, "legacy"),
                (4, 0, '{"title":"内部配置"}'),
            ]:
                db.add(GptsTools(id=ident, type=7, tenant_id=1, is_preset=kind,
                                 name=f"quote_{ident}", tool_key=f"key_{ident}", extra=extra))
            await db.commit()
        with patch("bisheng.company_board.domain.repositories.catalog.get_async_db_session", self.session):
            _, assets = await load_catalog(1)
        self.assertEqual({row["id"]: row["name"] for row in assets}, {
            "tool:1":"物资询价", "tool:2":"批量询价", "tool:3":"quote_3", "tool:4":"quote_4",
        })
        self.assertTrue(all(row["context_key"] == "toolset:7" for row in assets))

    async def releases(self, tenant=1):
        async with self.session() as db:
            return list(
                (
                    await db.exec(
                        select(BoardLedger)
                        .where(
                            BoardLedger.tenant_id == tenant,
                            BoardLedger.kind == "release",
                        )
                        .order_by(BoardLedger.id, BoardLedger.revision)
                    )
                ).all()
            )

    async def test_new_assets_fulfil_year_plan_republish_and_rollback(self):
        pub.install_publication_tracking()
        pub.install_publication_tracking()
        async with self.session() as db:
            db.add_all(
                [
                    Department(id=10, tenant_id=1, dept_id="d10", name="原部门"),
                    Department(id=20, tenant_id=2, dept_id="d20", name="其他租户部门"),
                    UserDepartment(id=1, user_id=7, department_id=20),
                    UserDepartment(id=2, user_id=7, department_id=10),
                    BoardLedger(
                        tenant_id=1,
                        id="plan",
                        revision=1,
                        kind="release",
                        year=2026,
                        parent_id="scene",
                        department_id=11,
                        name="计划助手",
                        asset_key="assistant:a",
                        operator_id=9,
                    ),
                    BoardLedger(
                        tenant_id=1,
                        id="lastyear",
                        revision=1,
                        kind="release",
                        year=2025,
                        name="旧年度计划",
                        asset_key="flow:w",
                        operator_id=9,
                    ),
                    Assistant(id="a", tenant_id=1, name="计划助手", user_id=7),
                    Flow(id="w", tenant_id=1, name="工作流", user_id=7, status=FlowStatus.OFFLINE.value),
                ]
            )
            await db.commit()
            assistant = await db.get(Assistant, "a")
            assistant.status = AssistantStatus.ONLINE.value
            await db.flush()
            await db.rollback()
            self.assertFalse(any(row.effective_date for row in await self.releases()))
            assistant = await db.get(Assistant, "a")
            assistant.status = AssistantStatus.ONLINE.value
            workflow = await db.get(Flow, "w")
            workflow.status = FlowStatus.ONLINE.value
            await db.commit()
            assistant.status = AssistantStatus.OFFLINE.value
            await db.commit()
            with patch.object(pub, "shanghai_today", return_value=date(2027, 3, 1)):
                assistant.status = AssistantStatus.ONLINE.value
                await db.commit()
        actual = {row.asset_key: row for row in await self.releases() if row.effective_date}
        self.assertEqual(len(await self.releases()), 4)
        self.assertEqual(
            (
                actual["assistant:a"].id,
                actual["assistant:a"].revision,
                actual["assistant:a"].parent_id,
                actual["assistant:a"].department_id,
            ),
            ("plan", 2, "scene", 11),
        )
        self.assertEqual((actual["flow:w"].department_id, actual["flow:w"].year), (10, 2026))
        self.assertTrue(all(r.effective_date == self.day for r in actual.values()))
        self.assertEqual(await ledger.release_info(1, date(2025, 12, 31)), {})

    @staticmethod
    def application(ident, tenant=1):
        return App(id=ident, slug=ident, name="托管" + ident, owner_user_id=0, tenant_id=tenant, state="draft")

    @staticmethod
    def audit(app_id, when, tenant=1, action="app.release.online"):
        return AuditLog(
            operator_id=0,
            tenant_id=tenant,
            action=action,
            audit_metadata={"app_id": app_id},
            create_time=datetime.fromisoformat(when),
        )

    async def test_legacy_republish_oldest_confirmed_audit_and_unknown(self):
        async with self.session() as db:
            db.add_all(
                [
                    self.application("old"),
                    self.application("unknown"),
                    Assistant(id="legacy", tenant_id=1, name="已上架过", create_time=datetime(2024, 1, 1)),
                    Knowledge(id=401, tenant_id=1, name="存量已发布", state=KnowledgeState.PUBLISHED.value),
                    self.audit("old", "2024-06-03"),
                    self.audit("old", "2025-07-08"),
                    self.audit("old", "2023-01-01", tenant=2),
                    self.audit("old", "2023-01-01", action="app.release.failed"),
                ]
            )
            await db.commit()
        pub.install_publication_tracking()
        self.assertEqual(await ledger.release_info(1, date(2024, 12, 31)), {"app:old": (None, date(2024, 6, 3))})
        async with self.session() as db:
            assistant = await db.get(Assistant, "legacy")
            assistant.status = AssistantStatus.ONLINE.value
            for app_id in ("old", "unknown"):
                self.assertTrue(await AppDao.aupdate_state_cas(db, app_id, from_states=("draft",), to_state="online"))
            await db.commit()
            db.add_all([self.audit("old", "2026-09-20"), self.audit("unknown", "2026-09-20")])
            await db.commit()
        await KnowledgeDao.async_update_state(401, KnowledgeState.PUBLISHED)
        self.assertEqual(await ledger.release_info(1, self.day), {"app:old": (None, date(2024, 6, 3))})
        rows = await ledger.list_ledger(1, 2024)
        self.assertEqual(
            [(r["asset_key"], r["name"], r["effective_date"]) for r in rows], [("app:old", "托管old", date(2024, 6, 3))]
        )
        self.assertEqual(await ledger.list_ledger(1, 2026), [])

    async def test_real_hosted_app_cas_failure_rollback_success_and_best_effort(self):
        pub.install_publication_tracking()
        async with self.session() as db:
            await AppDao.acreate(db, self.application("new"))
            await db.commit()
            self.assertFalse(await AppDao.aupdate_state_cas(db, "new", from_states=("stopped",), to_state="online"))
            await db.commit()
            self.assertTrue(await AppDao.aupdate_state_cas(db, "new", from_states=("draft",), to_state="online"))
            await db.rollback()
            self.assertEqual(await self.releases(), [])
            self.assertTrue(await AppDao.aupdate_state_cas(db, "new", from_states=("draft",), to_state="online"))
            await db.commit()
        self.assertEqual(await ledger.release_info(1, self.day), {"app:new": (None, self.day)})
        # Real database failure inside the observer, while the source tables work.
        async with self.engine.begin() as conn:
            await conn.run_sync(BoardLedger.__table__.drop)
        async with self.session() as db:
            await AppDao.acreate(db, self.application("degraded"))
            self.assertTrue(await AppDao.aupdate_state_cas(db, "degraded", from_states=("draft",), to_state="online"))
            await db.commit()
        async with self.session() as db:
            self.assertEqual((await db.get(App, "degraded")).state, "online")
        async with self.engine.begin() as conn:
            await conn.run_sync(BoardLedger.__table__.create)
        async with self.session() as db:
            self.assertTrue(await AppDao.aupdate_state_cas(db, "degraded", from_states=("online",), to_state="stopped"))
            with patch.object(pub, "shanghai_today", return_value=date(2027, 7, 1)):
                self.assertTrue(
                    await AppDao.aupdate_state_cas(db, "degraded", from_states=("stopped",), to_state="online")
                )
            await db.commit()
        self.assertEqual(await ledger.release_info(1, self.day), {"app:degraded": (None, self.day)})

    async def test_real_knowledge_skill_updates_and_tool_visibility(self):
        pub.install_publication_tracking()
        async with self.session() as db:
            db.add_all(
                [
                    Knowledge(id=1, tenant_id=1, name="公开库", state=KnowledgeState.UNPUBLISHED.value),
                    Knowledge(id=2, tenant_id=1, name="私有", type=KnowledgeTypeEnum.PRIVATE.value),
                    Knowledge(id=3, tenant_id=1, name="授权", auth_type=AuthTypeEnum.APPROVAL),
                    LinsightSkill(id=4, tenant_id=1, name="admin", description="", object_path="a", enabled=False),
                    LinsightSkill(
                        id=5, tenant_id=1, name="mine", description="", object_path="b", owner_user_id=9, enabled=False
                    ),
                    GptsToolsType(id=6, tenant_id=1, name="租户工具组", is_shared=False),
                    GptsToolsType(id=7, tenant_id=2, name="其他租户组"),
                    GptsToolsType(id=8, tenant_id=1, name="已删除组", is_delete=1),
                    Flow(
                        id="hidden",
                        tenant_id=1,
                        name="非工作流",
                        flow_type=FlowType.WORKSTATION.value,
                        status=FlowStatus.ONLINE.value,
                    ),
                ]
            )
            await db.flush()
            for gid in (6, 7, 8):
                db.add(GptsTools(id=gid, tenant_id=1, name="子工具", tool_key=f"k{gid}", type=gid))
            await db.commit()
        for ident in (1, 2, 3, 1000, 1):
            await KnowledgeDao.async_update_state(ident, KnowledgeState.PUBLISHED)
        self.assertTrue(await LinsightSkillDao.set_enabled("admin", True))
        self.assertTrue(await LinsightSkillDao.set_enabled("mine", True, owner_user_id=9))
        self.assertFalse(await LinsightSkillDao.set_enabled("missing", True))
        self.assertEqual(sorted(row.asset_key for row in await self.releases()), ["knowledge:1", "skill:4", "tool:6"])

        with patch("bisheng.tool.domain.models.gpts_tools.get_async_db_session", self.session):
            valid = GptsToolsTypeRead(
                tenant_id=1,
                name="新登记工具组",
                children=[GptsTools(id=91, tenant_id=1, name="解析报价", tool_key="pending")],
            )
            await GptsToolsDao.insert_tool_type(valid)
            # The original DAO commits the group before its children. A child
            # batch with duplicate generated tool keys must yield no release.
            invalid = GptsToolsTypeRead(
                tenant_id=1,
                name="重复子工具",
                children=[GptsTools(id=i, tenant_id=1, name="重名工具", tool_key="pending") for i in (92, 93)],
            )
            with self.assertRaises(IntegrityError):
                await GptsToolsDao.insert_tool_type(invalid)
        self.assertEqual(
            sorted(row.asset_key for row in await self.releases()), ["knowledge:1", "skill:4", "tool:6", "tool:91"]
        )
