import unittest
from contextlib import asynccontextmanager
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.repositories import monitoring as repo
from bisheng.company_board.domain.services.monitoring import add_terminal_stats, monthly_scope
from bisheng.core.context.tenant import current_tenant_id


class MonitoringTest(unittest.IsolatedAsyncioTestCase):
    def test_reuse_and_release_deduplicate_and_honor_end_date(self):
        assets = [{"id": "tool:1", "kind": "tool", "name": "A"}]
        records = [
            {"kind": "topic", "id": "t", "name": "T"},
            {"kind": "scene", "id": "s", "parent_id": "t", "name": "S"},
            {"kind": "scene", "id": "s2", "parent_id": "t", "name": "S2"},
            {"kind": "release", "asset_key": "tool:1", "parent_id": "s", "effective_date": date(2025, 1, 1)},
        ]
        links = [
            {"date": date(2026, 1, 1), "parent_id": i, "fields": {"end": "2026-01-20", "asset": "tool:1"}}
            for i in ["s", "s2"]
        ]

        def scope(cutoff, scene):
            return monthly_scope(assets, records, {"tool:1": 17}, cutoff, "t", scene, "17", "tool", links)[0]

        self.assertEqual(scope(date(2026, 1, 20), "")[0]["scene_ids"], ["s", "s2"])
        self.assertEqual(scope(date(2026, 1, 21), "s2"), [])
        self.assertEqual(len(scope(date(2026, 1, 1), "s")), 1)

    async def test_beijing_days_status_coverage_and_tenant(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        self.addAsyncCleanup(engine.dispose)
        token = current_tenant_id.set(1)
        self.addCleanup(current_tenant_id.reset, token)
        async with engine.begin() as conn:
            await conn.run_sync(BoardRuntimeEvent.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(engine, expire_on_commit=False) as db:
                yield db

        async with session() as db:
            for i, (asset, status, moment) in enumerate(
                [
                    ("1", "success", datetime(2025, 12, 31, 16)),
                    ("1", "failed", datetime(2026, 1, 1, 16)),
                    ("2", "success", datetime(2025, 12, 30)),
                    ("3", "entered", datetime(2026, 1, 1)),
                    ("4", "cancelled", datetime(2026, 1, 1)),
                    ("5", "success", datetime(2026, 1, 31, 16)),
                ]
            ):
                db.add(
                    BoardRuntimeEvent(
                        id=str(i),
                        run_id=str(i),
                        user_id=2,
                        tenant_id=1,
                        kind="tool",
                        asset_id=asset,
                        status=status,
                        occurred_at=moment,
                    )
                )
            await db.commit()
        with patch.object(repo, "get_async_db_session", session):
            known, series = await repo.monthly_terminals(1, datetime(2025, 12, 31, 16), datetime(2026, 1, 31, 16))
            assets = [{"id": f"tool:{n}"} for n in range(1, 6)]
            daily = add_terminal_stats(assets, known, series)
            self.assertEqual(daily, [{"day": 1, "success": 1, "failed": 0}, {"day": 2, "success": 0, "failed": 1}])
            self.assertEqual([a["monitored"] for a in assets], [True, True, False, True, False])
            self.assertEqual((assets[0]["success"], assets[0]["failed"]), (1, 1))
            self.assertEqual(await repo.monthly_terminals(2, datetime(2025, 12, 31), datetime(2026, 1, 31)), ([], []))

    async def test_other_users_excerpts_are_never_fetched(self):
        with patch.object(repo, "get_async_db_session", side_effect=AssertionError("queried private messages")):
            self.assertEqual(await repo.own_excerpts(1, 2, SimpleNamespace(user_id=3)), (None, None))
        self.assertEqual(repo.visible_text('{"content":"public","reasoning_content":"internal"}', True), "public")
        self.assertIsNone(repo.visible_text('{"reasoning_content":"internal"}', True))
