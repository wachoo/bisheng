import unittest
from contextlib import asynccontextmanager
from datetime import date
from unittest.mock import patch
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories import planning
from bisheng.company_board.domain.repositories.supplement import list_supplements
from bisheng.company_board.domain.schemas.planning import Collection, Scene, Targets, Topic
from bisheng.core.context.tenant import current_tenant_id, set_current_tenant_id
from bisheng.database.models.department import Department


class PlanningTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tenant = set_current_tenant_id(1)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        async with self.engine.begin() as conn:
            for table in (BoardSupplement, BoardLedger, Department):
                await conn.run_sync(table.__table__.create)

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        self.session = session
        for module in ("planning", "supplement"):
            self.enterContext(
                patch("bisheng.company_board.domain.repositories." + module + ".get_async_db_session", session)
            )
        async with session() as db:
            for i in range(1, 4):
                db.add(Department(id=i, tenant_id=1, dept_id=f"d{i}", name=f"Unit {i}"))
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()
        current_tenant_id.reset(self.tenant)

    async def save(self, edit):
        return await planning.save_plan(1, 20, 2025, edit, {"knowledge:1"})

    async def item(self, kind):
        return next(i for i in (await planning.read_plan(1, 2025))["items"] if i["kind"] == kind)

    async def test_targets_and_nested_scene_changes_are_atomic(self):
        await self.save(Targets(kind="targets", employee=10, scene=20))
        with self.assertRaises(BoardLedgerConflictError):
            await self.save(Targets(kind="targets", employee=999, scene=999))
        await self.save(Topic(kind="topic", name="Procurement"))
        topic = await self.item("topic")
        params = {
            "kind": "scene",
            "name": "Quotes",
            "topic_id": topic["id"],
            "department_id": 1,
            "planned_date": "2025-05-05",
            "completed_date": "2025-05-13",
        }
        await self.save(
            Scene(
                **params,
                supports=[{"department": 2, "start": "2025-03-01"}, {"department": 3, "start": "2025-03-02"}],
                recognition=[{"start": "2025-06-01"}],
            )
        )
        scene = await self.item("scene")
        self.assertEqual(len(scene["supports"]), 2)
        stale = Scene(**scene)
        wrong = [{"id": uuid4(), "department": 3, "start": "2025-04-04"}]
        with self.assertRaises(BoardLedgerInvalidError):
            await self.save(Scene(**{**scene, "supports": wrong, "name": "Should roll back"}))
        self.assertEqual((await self.item("scene"))["version"], scene["version"])
        await self.save(Scene(**{**scene, "supports": [scene["supports"][0]], "recognition": []}))
        with self.assertRaises(BoardLedgerConflictError):
            await self.save(stale)
        read = await list_supplements(1, date(2025, 12, 31))
        self.assertEqual(len([r for r in read if r["kind"] == "scene-team"]), 1)
        self.assertFalse(any(r["kind"] == "recognition" for r in read))
        with self.assertRaises(ValidationError):
            Scene(**params, supports=[{"department": 1, "start": "2025-01-01"}])
        with self.assertRaises(BoardLedgerInvalidError):
            await self.save(Scene(**{**params, "name": "Wrong tenant", "department_id": 4}))
        self.assertEqual((await planning.read_plan(1, 2025))["targets"]["employee"], 10)

    async def test_existing_collection_and_category_survive_combined_write(self):
        topic_id, collection_id = str(uuid4()), str(uuid4())
        async with self.session() as db:
            db.add(
                BoardLedger(tenant_id=1, id=topic_id, revision=1, kind="topic", year=2025, name="Legacy", operator_id=1)
            )
            db.add(
                BoardLedger(
                    tenant_id=1,
                    id=collection_id,
                    revision=1,
                    kind="collection",
                    year=2025,
                    parent_id=topic_id,
                    department_id=1,
                    name="Policy",
                    operator_id=1,
                )
            )
            await db.commit()
        row = await self.item("collection")
        self.assertIsNone(row["category"])
        changes = {**row, "category": "Procurement", "planned_date": "2025-06-01", "completed_date": "2025-06-15"}
        with self.assertRaises(ValidationError):
            Collection(**changes)
        with self.assertRaises(BoardLedgerInvalidError):
            await self.save(Collection(**{**changes, "asset_key": "knowledge:foreign"}))
        await self.save(Collection(**{**changes, "asset_key": "knowledge:1"}))
        current = await self.item("collection")
        self.assertEqual(
            (current["id"], current["category"], current["asset_key"]), (collection_id, "Procurement", "knowledge:1")
        )
        self.assertEqual(len([r for r in (await planning.read_plan(1, 2025))["items"] if r["kind"] == "collection"]), 1)
        self.assertEqual((await planning.read_plan(2, 2025))["items"], [])
