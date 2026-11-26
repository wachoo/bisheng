import unittest
from contextlib import asynccontextmanager
from datetime import datetime
from unittest.mock import patch

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.company_board.domain.models.feedback import BoardIssueResolution, BoardRating
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.repositories import feedback
from bisheng.core.context.tenant import current_tenant_id
from bisheng.core.database.tenant_filter import register_tenant_filter_events


class FeedbackTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as conn:
            for model in (BoardRating, BoardRuntimeEvent, BoardIssueResolution):
                await conn.run_sync(model.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        self.session = session
        self.factory = patch.object(feedback, "get_async_db_session", session)
        self.factory.start()
        async with session() as db:
            for i, (status, tenant) in enumerate([("success", 1), ("failed", 1), ("success", 2)]):
                db.add(
                    BoardRuntimeEvent(
                        id=str(i),
                        run_id=str(i),
                        tenant_id=tenant,
                        asset_id="asset",
                        user_id=8,
                        kind="employee",
                        status=status,
                        terminal_message_id=i + 10,
                        occurred_at=datetime(2026, 1, 1),
                    )
                )
                for rating in (2, 1, 2):
                    db.add(
                        BoardRating(
                            tenant_id=tenant, user_id=8, message_id=i + 10, rating=rating, rated_at=datetime(2026, 1, 2)
                        )
                    )
            await db.commit()

    async def asyncTearDown(self):
        self.factory.stop()
        await self.engine.dispose()

    async def test_history_tenant_scope_and_idempotent_resolution(self):
        register_tenant_filter_events()
        token = current_tenant_id.set(1)
        self.addCleanup(current_tenant_id.reset, token)
        start, cutoff = datetime(2026, 1, 1), datetime(2026, 2, 1)
        before = await feedback.feedback_snapshot(1, start, cutoff, False, 0, 10)
        self.assertEqual(before, {"pending": 1, "closed": 0, "total": 1, "rows": []})
        with patch.object(feedback, "utc_now", return_value=datetime(2026, 2, 2)):
            await feedback.resolve_issue(1, 27, "0", "Corrected")
            await feedback.resolve_issue(1, 27, "0", "Duplicate")
        historic = await feedback.feedback_snapshot(1, start, cutoff, True, 0, 10)
        self.assertEqual(historic["pending"], 1)
        self.assertEqual([r["run_id"] for r in historic["rows"]], ["0"])
        current = await feedback.feedback_snapshot(1, start, datetime(2026, 3, 1), True, 0, 10)
        self.assertEqual((current["closed"], current["rows"][0]["measure"]), (1, "Corrected"))
        current_tenant_id.set(2)
        self.assertEqual((await feedback.feedback_snapshot(2, start, cutoff, True, 0, 10))["rows"][0]["run_id"], "2")

    async def test_satisfaction_keeps_unrated_tasks_in_denominator(self):
        register_tenant_filter_events()
        token = current_tenant_id.set(1)
        self.addCleanup(current_tenant_id.reset, token)
        async with self.session() as db:
            db.add(
                BoardRuntimeEvent(
                    id="unrated",
                    run_id="unrated",
                    tenant_id=1,
                    asset_id="asset",
                    user_id=8,
                    kind="employee",
                    status="success",
                    terminal_message_id=99,
                    occurred_at=datetime(2026, 1, 3),
                )
            )
            await db.commit()
        result = await feedback.satisfaction(1, datetime(2026, 1, 1), datetime(2026, 2, 1))
        self.assertEqual(result, {"successful": 2, "linked": 2, "negative": 1, "positive_rate": 0.5})
