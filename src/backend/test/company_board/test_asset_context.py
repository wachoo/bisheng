import unittest
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime, timedelta
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
from bisheng.database.models.assistant import Assistant
from bisheng.database.models.audit_log import AuditLog


class AssetContextTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.token = set_current_tenant_id(3)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as db:
            for model in (BoardLedger, BoardSupplement, Assistant, AuditLog):
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
        self.user = SimpleNamespace(user_id=17, tenant_id=3, is_global_super=False)
        self.day = service.today()
        self.topic, self.scene = str(uuid4()), str(uuid4())
        self.key = "assistant:sample"
        self.published = [{"id": self.key, "kind": "employee", "name": "采购助手"}]
        self.stack.enter_context(
            patch.object(asset_projection, "load_catalog", AsyncMock(return_value=([], self.published)))
        )
        async with session() as db:
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
        self.assertEqual((before["topic"], before["revision"], before["scene_ids"]), (default, 0, []))
        form = self.form(
            topic=self.topic,
            scenes=[self.scene],
            case_name="报价比对",
            case_fields={"input": "报价单", "sampleTable": '[["供应商"],["甲"]]'},
        )
        for _ in range(2):
            saved = await service.save_asset_context(self.user, 3, self.key, form)
            self.assertEqual(saved["revision"], 1)
        self.auth.assert_awaited_with(self.user, resource_type="assistant", resource_id="sample", action="edit")
        after = await service.read_asset_context(self.user, 3, self.key, self.day.year)
        self.assertEqual(
            (after["topic"], after["scene_ids"], after["case_name"]), (self.topic, [self.scene], "报价比对")
        )
        projections = await supplement.list_supplements(3, self.day)
        self.assertEqual({r["kind"] for r in projections}, {"scene-asset", "case"})
        self.assertEqual(next(r for r in projections if r["kind"] == "case")["fields"]["assets"], self.key)
        self.assertEqual(await supplement.list_supplements(3, self.day - timedelta(days=1)), [])
        with self.assertRaises(BoardLedgerConflictError):
            await service.save_asset_context(self.user, 3, self.key, self.form())
        await service.save_asset_context(
            self.user, 3, self.key, self.form(revision=1, topic=self.topic, case_name="无场景案例")
        )
        projections = await supplement.list_supplements(3, self.day)
        self.assertEqual([(r["kind"], r["parent_id"]) for r in projections], [("case", self.topic)])
        self.published.clear()
        self.assertEqual(await supplement.list_supplements(3, self.day), [])

    async def test_asset_http_read_write_read_uses_asset_authority_without_board_menu(self):
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient

        from bisheng.common.dependencies.user_deps import UserPayload
        from bisheng.company_board.api.asset_context import router

        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[UserPayload.get_login_user] = lambda: self.user
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            options = (await client.get("/asset-context/options")).json()["data"]
            self.assertIn({"id": options["default_topic"], "name": "AI先锋行动"}, options["topics"])
            path = "/asset-context/" + self.key
            request = {
                "year": self.day.year,
                "revision": 0,
                "topic": self.topic,
                "scenes": [self.scene],
                "profile": {"direction": "采购"},
                "case_name": "比价",
                "case_fields": {"output": "供应商报价表"},
            }
            for _ in range(2):
                self.assertEqual((await client.put(path, json=request)).json()["data"]["revision"], 1)
            data = (await client.get(path)).json()["data"]
            self.assertEqual(
                (data["topic"], data["scene_ids"], data["case_name"], data["profile"]),
                (self.topic, [self.scene], "比价", {"direction": "采购"}),
            )

    async def test_legacy_profile_is_editable_and_explicit_clear_replaces_it(self):
        async with self.session() as db:
            db.add(
                BoardSupplement(
                    tenant_id=3,
                    id=str(uuid4()),
                    revision=1,
                    kind="asset-profile",
                    year=self.day.year,
                    name="旧业务说明",
                    parent_id=self.key,
                    business_date=self.day,
                    payload='{"direction":"采购","description":"旧描述"}',
                    operator_id=12,
                    recorded_at=datetime.now(),
                )
            )
            await db.commit()
        context = await service.read_asset_context(self.user, 3, self.key, self.day.year)
        self.assertEqual(context["profile"], {"direction": "采购", "description": "旧描述"})
        await service.save_asset_context(
            self.user, 3, self.key, self.form(profile={"direction": "制造", "description": "产能"})
        )
        (row,) = await supplement.list_supplements(3, self.day, ["asset-profile"])
        self.assertEqual((row["parent_id"], row["fields"]), (self.key, {"direction": "制造", "description": "产能"}))
        await service.save_asset_context(self.user, 3, self.key, self.form(revision=1, profile={}))
        self.assertEqual(await supplement.list_supplements(3, self.day, ["asset-profile"]), [])

    async def test_invalid_scene_cross_tenant_and_readonly_asset(self):
        with self.assertRaises(BoardLedgerInvalidError):
            await service.save_asset_context(self.user, 3, self.key, self.form(scenes=[self.scene]))
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
