import unittest
from contextlib import asynccontextmanager
from datetime import datetime
from unittest.mock import patch

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.repositories import subjects
from bisheng.company_board.domain.repositories.planning_departments import BoardDepartments
from bisheng.company_board.domain.services.runtime import summarize


class SkillUsageTest(unittest.IsolatedAsyncioTestCase):
    def test_only_skill_receipts_establish_a_skill_count(self):
        counts = [("employee", "assistant-1", "success", None, 3, 0, None)]
        departments = BoardDepartments([], {})
        summary = summarize(counts, [], departments)
        self.assertIsNone(summary["skill_calls"])
        self.assertEqual(sum(row["count"] for row in summary["usage"]), 3)
        counts.append(("skill", "42", "entered", None, 2, 0, None))
        summary = summarize(counts, [], departments)
        self.assertEqual(summary["skill_calls"], 2)
        self.assertEqual(sum(row["count"] for row in summary["usage"]), 5)

    async def test_skill_history_only_covers_bins_with_receipts(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as conn:
            await conn.run_sync(BoardRuntimeEvent.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(engine) as db:
                yield db

        async with session() as db:
            db.add(BoardRuntimeEvent(
                id="old-entry", run_id="old-run", tenant_id=1, user_id=1, asset_id="42",
                kind="skill", status="entered", occurred_at=datetime(2026, 1, 2),
            ))
            await db.commit()

        async def history(first, end):
            return await subjects.asset_activity(
                1, "skill:42", datetime(2026, 1, first), datetime(2026, 1, end), "", False, "", "", 1,
            )

        with patch.object(subjects, "get_async_db_session", session):
            sample = await history(1, 4)
            self.assertTrue(sample["known"])
            self.assertEqual([row["entered"] for row in sample["series"]], [None, 1, None])
            later = await history(3, 4)
            self.assertFalse(later["known"])
            self.assertIsNone(later["series"][0]["entered"])
