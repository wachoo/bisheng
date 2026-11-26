import unittest
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.errcode.company_board import BoardLedgerConflictError
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.supplement import list_supplements, save_supplement
from bisheng.company_board.domain.schemas.research_report import ResearchReportInput
from bisheng.company_board.domain.schemas.supplement import SupplementInput
from bisheng.company_board.domain.services.research_report import read_report, write_report
from bisheng.core.context.tenant import current_tenant_id, set_current_tenant_id


def subject(name="复核课题"):
    return {"id": str(uuid4()), "name": name, "project": "年度科研项目", "ai": True, "start": "2024-02-01"}


def report(*, month=5, revision=0, subjects=None, **metrics):
    return ResearchReportInput(year=2024, month=month, revision=revision, subjects=subjects or [], metrics=metrics)


class ResearchReportTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tenant_token = set_current_tenant_id(3)
        self.user = SimpleNamespace(tenant_id=3, user_id=1, is_admin=lambda: True)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as conn:
            await conn.run_sync(BoardSupplement.__table__.create)
        self.stack = AsyncExitStack()

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        for name in ("research_report", "supplement"):
            self.stack.enter_context(
                patch(f"bisheng.company_board.domain.repositories.{name}.get_async_db_session", session)
            )

    async def asyncTearDown(self):
        await self.stack.aclose()
        await self.engine.dispose()
        current_tenant_id.reset(self.tenant_token)

    async def test_monthly_as_of_null_zero_subjects_conflicts_and_tenant(self):
        line = subject()
        first = report(outstanding=8, spending="0", subjects=[line])
        for _ in range(2):
            saved = await write_report(self.user, first)
            self.assertEqual(saved["revision"], 1)
        self.assertEqual(saved["metrics"]["spending"], "0")
        self.assertIsNone(saved["metrics"]["budget"])
        self.assertEqual((await read_report(self.user, "lead", 2024, 4))["source"], "empty")
        june = await read_report(self.user, "lead", 2024, 6)
        self.assertEqual((june["revision"], june["source_month"], june["subjects"][0]["name"]), (0, 5, line["name"]))
        await write_report(self.user, report(month=6, outstanding="5.2", subjects=[line], equivalent_days="1.5"))
        self.assertEqual((await read_report(self.user, "lead", 2024, 5))["metrics"]["outstanding"], "8")
        august = await read_report(self.user, "lead", 2024, 8)
        self.assertEqual(august["metrics"]["outstanding"], "5.2")
        self.assertEqual(
            august["history"],
            [
                {"month": 5, "equivalent_days": None, "equivalent_value": None},
                {"month": 6, "equivalent_days": "1.5", "equivalent_value": None},
            ],
        )
        following = await read_report(self.user, "lead", 2025, 1)
        self.assertIsNone(following["metrics"]["outstanding"])
        self.assertEqual(following["subjects"][0]["id"], line["id"])
        await write_report(self.user, report(month=6, revision=1, outstanding="6"))
        self.assertEqual((await read_report(self.user, "lead", 2024, 7))["subjects"], [])
        with self.assertRaises(BoardLedgerConflictError):
            await write_report(self.user, report(month=6, revision=1, outstanding="8"))
        self.assertEqual(await list_supplements(3, date(2024, 12, 31)), [])
        other = set_current_tenant_id(4)
        try:
            self.assertEqual((await read_report(self.user, "lead", 2024, 6))["source"], "empty")
        finally:
            current_tenant_id.reset(other)

    async def test_legacy_fallback_ends_at_first_direct_report(self):
        project_id = uuid4()
        for kind, fields in [("project", {"ai": "yes", "budget": "20001.02"}), ("expense", {"amount": "3000.80"})]:
            await save_supplement(
                3,
                1,
                SupplementInput(
                    id=project_id if kind == "project" else uuid4(),
                    revision=0,
                    year=2024,
                    kind=kind,
                    name=kind,
                    parent_id=None if kind == "project" else str(project_id),
                    date=date(2024, 2, 1),
                    fields=fields,
                ),
                set(),
            )
        old = await read_report(self.user, "lead", 2024, 4)
        self.assertEqual(
            (old["source"], old["metrics"]["budget"], old["metrics"]["spending"]), ("legacy", "2.0001", "0.3001")
        )
        await write_report(self.user, report(spending="1.5"))
        later = await read_report(self.user, "lead", 2024, 5)
        self.assertEqual(later["metrics"]["spending"], "1.5")
        self.assertIsNone(later["metrics"]["budget"])
        self.assertEqual((await read_report(self.user, "lead", 2024, 3))["metrics"]["spending"], "0.3001")

    def test_counts_amounts_and_repeated_subjects(self):
        row = subject()
        for invalid in [
            {"projects": 1, "ai_projects": 2},
            {"projects": 1, "active_ai_projects": 2},
            {"ai_projects": 1, "active_ai_projects": 2},
            {"budget": -1},
            {"subjects": [row, row]},
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                report(**invalid)
