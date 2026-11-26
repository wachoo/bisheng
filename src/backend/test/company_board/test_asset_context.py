import json
import unittest
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.common.errcode.http_error import UnAuthorizedError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories import asset_context as repo
from bisheng.company_board.domain.repositories import asset_projection, ledger, supplement
from bisheng.company_board.domain.services import asset_context as service
from bisheng.core.context.tenant import current_tenant_id, set_current_tenant_id
from bisheng.knowledge.domain.models.knowledge import Knowledge
from bisheng.database.models.assistant import Assistant
from bisheng.database.models.audit_log import AuditLog


class AssetContextTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.token = set_current_tenant_id(3)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as db:
            for model in (BoardLedger, BoardSupplement, Assistant, Knowledge, AuditLog):
                await db.run_sync(model.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        self.session = session
        self.stack = AsyncExitStack()
        for module in (repo, ledger, service, supplement):
            self.stack.enter_context(patch.object(module, "get_async_db_session", session))
        self.auth = self.stack.enter_context(patch.object(service, "require_business_action", new_callable=AsyncMock))
        self.category = str(uuid4())
        self.targets = self.stack.enter_context(patch.object(service, "knowledge_targets", new_callable=AsyncMock))
        self.targets.return_value = [{"id": self.category, "name": "采购标准"}]
        self.user = SimpleNamespace(user_id=17, tenant_id=3, is_global_super=False)
        self.day = service.today()
        self.topic, self.scene = str(uuid4()), str(uuid4())
        self.key = "assistant:sample"
        self.published = [{"id": self.key, "kind": "employee", "name": "采购助手"}]
        self.stack.enter_context(
            patch.object(asset_projection, "load_catalog", AsyncMock(return_value=([], self.published)))
        )
        async with session() as db:
            db.add(Knowledge(id=42, tenant_id=3, name="采购制度", type=0))
            db.add(Assistant(id="sample", user_id=17, tenant_id=3, name="采购助手"))
            for kind, ident, name, parent in (
                ("topic", self.topic, "供应链", None),
                ("scene", self.scene, "比价", self.topic),
            ):
                db.add(
                    BoardLedger(
                        id=ident,
                        kind=kind,
                        name=name,
                        parent_id=parent,
                        year=self.day.year,
                        revision=1,
                        tenant_id=3,
                        operator_id=12,
                    )
                )
            await db.commit()

    async def asyncTearDown(self):
        await self.stack.aclose()
        await self.engine.dispose()
        current_tenant_id.reset(self.token)

    def form(self, **extra):
        return service.AssetContextInput(year=self.day.year, **{"revision": 0, **extra})

    async def test_default_without_plan_and_optional_fields_resolved_after_publish(self):
        plan = await ledger.list_ledger(3, self.day.year)
        await service.attach_asset_topics(3, self.day.year, self.day, self.published, plan)
        default = repo.topic_id(3, self.day.year, "AI先锋行动")
        self.assertEqual(self.published[0]["topic_id"], default)
        self.assertEqual(next(t["name"] for t in plan if t["id"] == default), "AI先锋行动")
        self.assertEqual(await repo.latest_bindings(3), {})
        before = await service.read_asset_context(self.user, 3, self.key, self.day.year)
        self.assertEqual((before["topic"], before["revision"]), (default, 0))
        for _ in range(2):
            self.assertEqual(await service.save_asset_context(self.user, 3, self.key, self.form(topic=self.topic)), {"revision": 1})
        self.auth.assert_awaited_with(self.user, resource_type="assistant", resource_id="sample", action="edit")
        self.assertEqual(await supplement.list_supplements(3, self.day), [])
        with self.assertRaises(BoardLedgerConflictError):
            await service.save_asset_context(self.user, 3, self.key, self.form())

    async def test_knowledge_category_options_validation_and_history(self):
        key = "knowledge:42"
        original = {"topic": self.topic, "topic_name": "供应链", "scenes": [self.scene],
                    "profile": {"direction": "成本"}, "case_name": "报价", "case_fields": {"input": "报价单"}}
        await repo.write_binding(3, key, 17, 0, self.day - timedelta(days=1), original)
        options = await service.options(3, self.day.year)
        self.assertEqual(options["categories"], [{"id":self.category, "name":"采购标准"}])
        self.targets.assert_awaited_with(3, self.day.year)
        with self.assertRaises(BoardLedgerInvalidError):
            await service.save_asset_context(self.user, 3, key, self.form(revision=1, knowledge_category_id=uuid4()))
        form = self.form(topic=self.topic, revision=1, knowledge_category_id=self.category)
        self.assertEqual(await service.save_asset_context(self.user, 3, key, form), {"revision": 2})
        new = await service.read_asset_context(self.user, 3, key, self.day.year)
        self.assertEqual((new["knowledge_category_id"], new["knowledge_category_name"]), (self.category, "采购标准"))
        binding = (await repo.latest_bindings(3, key=key))[key]
        self.assertEqual(json.loads(binding.payload), {**original, "knowledge_category_id": self.category, "knowledge_category_name":"采购标准"})
        self.assertEqual(json.loads((await repo.latest_bindings(3, self.day-timedelta(days=1)))[key].payload), original)
        with self.assertRaises(BoardLedgerInvalidError):
            await service.save_asset_context(self.user, 3, self.key, self.form(topic=self.topic, knowledge_category_id=self.category))
        await service.save_asset_context(
            self.user, 3, key, self.form(revision=2, topic=self.topic, knowledge_category_id=None)
        )
        cleared = json.loads((await repo.latest_bindings(3, key=key))[key].payload)
        self.assertIsNone(cleared["knowledge_category_id"])
        self.assertNotIn("knowledge_category_name", cleared)
        with self.assertRaises(UnAuthorizedError):
            await service.save_asset_context(self.user, 4, key, form)

    async def test_legacy_verified_library_can_clear_its_displayed_category(self):
        from bisheng.company_board.domain.repositories.planning import category_key

        async with self.session() as db:
            db.add(BoardLedger(id="old-plan", tenant_id=3, revision=1, kind="collection", year=self.day.year,
                               name="旧接入计划", asset_key="knowledge:42", effective_date=self.day, operator_id=17))
            await db.commit()
        read = await service.read_asset_context(self.user, 3, "knowledge:42", self.day.year)
        self.assertEqual(read["knowledge_category_id"], category_key(3, "未归类"))
        await service.save_asset_context(self.user, 3, "knowledge:42", service.AssetContextInput(
            year=self.day.year, revision=read["revision"], topic=read["topic"], knowledge_category_id=None))
        read = await service.read_asset_context(self.user, 3, "knowledge:42", self.day.year)
        self.assertIsNone(read["knowledge_category_id"])

    async def test_asset_http_roundtrip_without_board_menu(self):
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient
        from bisheng.common.dependencies.user_deps import UserPayload
        from bisheng.company_board.api.asset_context import router

        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[UserPayload.get_login_user] = lambda: self.user
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            options = (await client.get("/asset-context/options")).json()["data"]
            self.assertIn({"id": self.category, "name": "采购标准"}, options["categories"])
            path = "/asset-context/" + self.key
            request = {"year":self.day.year, "revision":0, "topic":self.topic}
            self.assertEqual((await client.put(path, json={**request, "case_name":"多余字段"})).status_code,422)
            for _ in range(2):
                self.assertEqual((await client.put(path, json=request)).json()["data"]["revision"], 1)
            self.assertEqual((await client.get(path)).json()["data"]["topic"], self.topic)

    async def test_invalid_topic_cross_tenant_and_readonly_asset(self):
        with self.assertRaises(BoardLedgerInvalidError):
            await service.save_asset_context(self.user, 3, self.key, self.form(topic=self.scene))
        self.auth.reset_mock()
        with self.assertRaises(UnAuthorizedError):
            await service.save_asset_context(self.user, 4, self.key, self.form(topic=self.topic))
        self.auth.assert_not_awaited()
        self.auth.side_effect = UnAuthorizedError()
        with self.assertRaises(UnAuthorizedError):
            await service.save_asset_context(self.user, 3, self.key, self.form(topic=self.topic))
        self.assertEqual(await repo.latest_bindings(3), {})

    def test_case_revisions_do_not_move_usage_and_switch_closes_the_previous_scene(self):
        import json
        from datetime import date

        def version(day, scenes, revision):
            return SimpleNamespace(
                parent_id=self.key,
                business_date=date(2026, 3, day),
                revision=revision,
                payload=json.dumps({"scenes": scenes}),
            )

        revisions = [version(1, ["A"], 1), version(8, ["A"], 2), version(12, ["B"], 3), version(12, ["C"], 4)]
        ranges = [
            (scene, first.business_date.day, end.day if end else None)
            for _, scene, first, end in asset_projection.scene_intervals(revisions)
        ]
        self.assertEqual(ranges, [("A", 1, 11), ("C", 12, None)])
