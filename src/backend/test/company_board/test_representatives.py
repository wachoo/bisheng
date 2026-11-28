import unittest
from contextlib import asynccontextmanager
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories import representatives, supplement
from bisheng.company_board.domain.services import representatives as service
from bisheng.core.context.tenant import current_tenant_id, set_current_tenant_id


class RepresentativeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.token = set_current_tenant_id(1)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as conn:
            await conn.run_sync(BoardSupplement.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        for module in (representatives, supplement):
            self.enterContext(patch.object(module, "get_async_db_session", session))
        self.topic = str(uuid4())
        self.user = SimpleNamespace(user_id=100, tenant_id=1)
        self.assets = [{"id": f"assistant:{i}", "kind": "employee", "topic_id": self.topic, "name": str(i)}
                       for i in range(1, 3)]
        self.enterContext(patch.object(service, "effective_day", return_value=date(2026, 11, 1)))
        self.access = self.enterContext(patch.object(service, "require_access", new_callable=AsyncMock))
        self.enterContext(patch.object(service, "topic_employees", new_callable=AsyncMock,
                                      return_value=({self.topic}, self.assets)))

    async def asyncTearDown(self):
        await self.engine.dispose()
        current_tenant_id.reset(self.token)

    async def test_choose_replace_clear_does_not_reactivate_old_case(self):
        legacy = {"id": "old", "year": 2026, "date": date(2026, 1, 1), "kind": "case",
                  "name": "A", "parent_id": self.topic, "fields": {"assets": self.assets[0]["id"]}}
        async def cases(day):
            rows = await supplement.list_supplements(1, day, [representatives.KIND])
            return await service.dashboard_cases(1, 2026, day, [legacy, *rows])

        await service.save_for(self.user, 2026, self.topic, "assistant:1", 0)
        await service.save_for(self.user, 2026, self.topic, "assistant:1", 0)
        with self.assertRaises(BoardLedgerConflictError):
            await service.save_for(self.user, 2026, self.topic, "assistant:2", 0)
        await service.save_for(self.user, 2026, self.topic, "assistant:2", 1)
        self.assertEqual((await cases(date(2026, 11, 10)))[0]["fields"]["assets"], "assistant:2")
        self.assets[1]["topic_id"] = "other"
        self.assertEqual(await cases(date(2026, 11, 10)), [])
        with self.assertRaises(BoardLedgerInvalidError):
            await service.save_for(self.user, 2026, self.topic, "assistant:2", 2)
        await service.save_for(self.user, 2026, self.topic, None, 2)
        self.assertEqual(await cases(date(2026, 11, 10)), [])
        self.assertEqual((await cases(date(2026, 10, 31)))[0]["id"], "old")
        self.access.assert_called_with(self.user, "manage")

    async def test_reject_other_topic_missing_employee_and_unauthorized_write(self):
        for topic, employee in [(self.topic, "knowledge:1"), ("other", "assistant:1")]:
            with self.assertRaises(BoardLedgerInvalidError):
                await service.save_for(self.user, 2026, topic, employee, 0)
        self.access.side_effect = PermissionError
        with self.assertRaises(PermissionError):
            await service.save_for(self.user, 2026, self.topic, "assistant:1", 0)
