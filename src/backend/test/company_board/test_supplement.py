import unittest
from contextlib import asynccontextmanager
from datetime import date
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.supplement import list_supplements, save_supplement
from bisheng.company_board.domain.schemas.supplement import SupplementInput
from bisheng.company_board.domain.services import supplement
from bisheng.core.context.tenant import current_tenant_id, set_current_tenant_id


def form(kind, *, day="2026-01-01", parent=None, **fields):
    return SupplementInput(
        id=uuid4(), revision=0, year=int(day[:4]), name=kind, kind=kind, parent_id=parent, date=day, fields=fields
    )


class SupplementTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tenant_token = set_current_tenant_id(3)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as conn:
            await conn.run_sync(BoardSupplement.__table__.create)
            await conn.run_sync(BoardLedger.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        self.patch = patch("bisheng.company_board.domain.repositories.supplement.get_async_db_session", session)
        self.patch.start()

    async def asyncTearDown(self):
        self.patch.stop()
        await self.engine.dispose()
        current_tenant_id.reset(self.tenant_token)

    async def write(self, obj, tenant=3):
        return await save_supplement(tenant, 15, obj, {"tool:1"})

    async def test_receivable_cross_year_allocation_and_report_cutoff(self):
        project = await self.write(form("project", day="2025-02-04", ai="yes", budget="400000"))
        milestone = form("receivable", day="2026-12-15", parent=project["id"], amount="10000", contract="A-12")
        await self.write(milestone)
        cash = form("receipt", day="2026-06-13", parent=str(milestone.id), amount="2500")
        await self.write(cash)
        await self.write(form("receipt", day="2026-11-10", parent=str(milestone.id), amount="7000"))
        june = await list_supplements(3, date(2026, 6, 30))
        self.assertEqual({r["kind"] for r in june}, {"project", "receivable", "receipt"})
        self.assertEqual([r["fields"]["amount"] for r in june if r["kind"] == "receipt"], ["2500"])
        with self.assertRaises(BoardLedgerInvalidError):
            await self.write(form("receipt", parent=str(milestone.id), amount="1000"))
        with self.assertRaises(BoardLedgerInvalidError):
            await self.write(
                milestone.model_copy(update={"revision": 1, "fields": {"amount": "9000", "contract": "A-12"}})
            )
        await self.write(cash.model_copy(update={"revision": 1, "fields": {"amount": "3000"}}))
        with self.assertRaises(BoardLedgerConflictError):
            await self.write(cash.model_copy(update={"revision": 1}))
        other = set_current_tenant_id(4)
        try:
            self.assertEqual(await list_supplements(4, None), [])
            with self.assertRaises(BoardLedgerInvalidError):
                await self.write(form("expense", parent=project["id"], amount="1000"), tenant=4)
        finally:
            current_tenant_id.reset(other)

    async def test_revisions_as_of_company_scope_and_restricted_projection(self):
        row = form("asset-profile", parent="tool:1", direction="采购")
        await self.write(row)
        await self.write(
            row.model_copy(update={"revision": 1, "date": date(2026, 8, 1), "fields": {"direction": "财务"}})
        )
        await self.write(form("project", ai="no"))
        earlier = await list_supplements(3, date(2026, 7, 31), ["asset-profile", "scene-asset"])
        self.assertEqual([(r["fields"], r["revision"]) for r in earlier], [({"direction": "采购"}, 1)])
        later = await list_supplements(3, date(2026, 9, 1), ["asset-profile"])
        self.assertEqual(later[0]["fields"], {"direction": "财务"})
        with self.assertRaises(BoardLedgerInvalidError):
            await self.write(form("asset-profile", parent="tool:outside", direction="采购"))

    def test_schema_rejects_invalid_classification_dates_amount_and_empty_profile(self):
        for factory in (
            lambda: form("value-rate", category="other", unit="task", hours="2", hourly="5"),
            lambda: form("project", ai="yes", end="2025-11-12"),
            lambda: form("expense", parent="project", amount="NaN"),
            lambda: form("receipt", parent="node", amount="-1"),
            lambda: form("asset-profile", parent="tool:1"),
            lambda: form("scene-team", parent="scene", department="-3"),
        ):
            with self.subTest(factory=factory), self.assertRaises(ValidationError):
                factory()
        self.assertEqual(form("expense", parent="project", amount="-20").fields["amount"], "-20")

    def test_case_table_preserves_legacy_text_and_checks_dimensions(self):
        import json

        def case(**fields):
            return form("case", parent="topic", scene="scene", **fields)

        self.assertEqual(case(output="旧版内容").fields["output"], "旧版内容")
        good = [["单位", "报价"], ["第一家", "12 万元"], ["第二家", "11 万元"]]
        result = case(sampleTable=json.dumps(good, ensure_ascii=False), sampleTitle="报价单", action="体验比价")
        self.assertEqual(json.loads(result.fields["sampleTable"]), good)
        bads = [
            [],
            [["header"]],
            [[""], ["a"]],
            [["A", "B"], ["1"]],
            [["A"], [" "]],
            [["A"], ["x" * 257]],
            [["A"] * 9, ["a"] * 9],
            [["A"], *[["r"]] * 21],
            [["A"], [None]],
            {},
        ]
        for grid in bads:
            with self.subTest(grid=grid), self.assertRaises(ValidationError):
                case(sampleTable=json.dumps(grid))
        with self.assertRaises(ValidationError):
            case(action="x" * 41)

    async def test_writes_require_manage_and_monitor_excludes_financials(self):
        user = object()
        with patch.object(supplement, "require_access", AsyncMock(side_effect=PermissionError)) as gate:
            with self.assertRaises(PermissionError):
                await supplement.save(user, form("project", ai="no"))
            gate.assert_awaited_once_with(user, "manage")
        with (
            patch.object(supplement, "require_access", AsyncMock()),
            patch.object(supplement, "tenant_for", return_value=3),
        ):
            await self.write(form("project", ai="yes"))
            await self.write(form("asset-profile", parent="tool:1", rules="规则"))
            rows = await supplement.read(user, "monitor", 2026, 2)
            self.assertEqual([r["kind"] for r in rows], ["asset-profile"])
