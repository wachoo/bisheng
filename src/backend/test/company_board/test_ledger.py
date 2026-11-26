import unittest
from contextlib import asynccontextmanager
from datetime import date
from unittest.mock import patch

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.repositories.ledger import list_ledger, save_ledger
from bisheng.company_board.domain.schemas.ledger import LedgerInput
from bisheng.company_board.domain.services.boards import strategic_totals


class LedgerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as connection:
            await connection.run_sync(BoardLedger.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as value:
                yield value

        self.patch = patch("bisheng.company_board.domain.repositories.ledger.get_async_db_session", session)
        self.patch.start()

    async def asyncTearDown(self):
        self.patch.stop()
        await self.engine.dispose()

    async def test_revision_and_period(self):
        first = LedgerInput(
            kind="goal",
            year=2026,
            name="新建场景",
            indicator="scene",
            target=10,
            unit="个",
            effective_date=date(2026, 1, 1),
        )
        saved = await save_ledger(1, 9, first)
        with self.assertRaises(BoardLedgerConflictError):
            await save_ledger(1, 9, first)
        second = first.model_copy(update={"target": 20, "effective_date": date(2026, 12, 1)})
        await save_ledger(1, 9, second, saved["id"], 1)
        with self.assertRaises(BoardLedgerConflictError):
            await save_ledger(1, 9, second, saved["id"], 1)
        self.assertEqual((await list_ledger(1, 2026, date(2026, 11, 30)))[0]["target"], 10)
        self.assertEqual((await list_ledger(1, 2026))[0]["target"], 20)
        self.assertEqual(await list_ledger(2, 2026), [])

    async def test_tenant_year_parent_and_strategic_totals(self):
        topic = await save_ledger(1, 7, LedgerInput(kind="topic", year=2026, name="采购"))
        scene = LedgerInput(
            kind="scene", year=2026, name="比价", parent_id=topic["id"], effective_date=date(2026, 9, 1)
        )
        with self.assertRaises(BoardLedgerInvalidError):
            await save_ledger(2, 8, scene)
        with self.assertRaises(BoardLedgerInvalidError):
            await save_ledger(1, 8, scene.model_copy(update={"year": 2027}))
        saved = await save_ledger(1, 8, scene)
        release = LedgerInput(
            kind="release",
            year=2026,
            name="采购助手",
            asset_key="assistant:a",
            parent_id=saved["id"],
            effective_date=date(2026, 10, 1),
        )
        await save_ledger(1, 9, release)
        await save_ledger(1, 9, LedgerInput(kind="collection", year=2026, name="采购制度", parent_id=topic["id"]))
        rows = await list_ledger(1, 2026)
        september = strategic_totals(rows, 2026, date(2026, 9, 30))
        self.assertEqual(september["scene_launched"], 1)
        self.assertEqual(september["employee_built"], 0)
        self.assertIsNone(september["employee_target"])
        self.assertEqual(september["knowledge_planned"], 1)
        self.assertEqual(september["knowledge_verified"], 0)
        self.assertEqual(strategic_totals(rows, 2026, date(2026, 10, 31))["employee_built"], 1)
