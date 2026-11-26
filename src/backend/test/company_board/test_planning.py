import json
import unittest
from contextlib import asynccontextmanager
from datetime import date, datetime
from unittest.mock import patch
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.errcode.company_board import BoardLedgerConflictError, BoardLedgerInvalidError
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories import planning
from bisheng.company_board.domain.repositories.scene_links import legacy_scene_assets, legacy_scene_links, managed_scene_assets
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
        for module in ("planning", "supplement", "scene_links", "asset_context"):
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
        return await planning.save_plan(1, 20, 2025, edit)

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

    async def test_scene_assets_supports_and_legacy_are_independent(self):
        await self.save(Topic(kind="topic", name="Services"))
        topic = await self.item("topic")
        basic = dict(kind="scene", name="Invoicing", topic_id=topic["id"], department_id=1,
                     planned_date="2025-06-01")
        await self.save(Scene(**basic, recognition=[{"start": "2025-06-01"}]))
        scene = await self.item("scene")
        second = {**basic, "id": scene["id"], "version": scene["version"]}
        catalog = {"assistant:1", "knowledge:2"}
        inherited = {"flow:retired"}
        linked = Scene(**second, support_department_ids=[2, 3], asset_keys=["flow:retired", "assistant:1"])
        await planning.save_plan(1, 20, 2025, linked, available_assets=catalog, inherited_assets=inherited)
        scene = await self.item("scene")
        self.assertEqual(scene["asset_keys"], ["assistant:1", "flow:retired"])
        self.assertEqual({(s["department"], s["start"], s["end"]) for s in scene["supports"]},
                         {(2, date(2025, 1, 1), None), (3, date(2025, 1, 1), None)})
        self.assertEqual(len(scene["recognition"]), 1)
        self.assertEqual(await managed_scene_assets(1, date(2025, 1, 1)), {scene["id"]: scene["asset_keys"]})
        self.assertEqual(await managed_scene_assets(2, None), {})
        with self.assertRaises(BoardLedgerConflictError):
            await planning.save_plan(1, 20, 2025, linked, available_assets=catalog)
        second["version"] = scene["version"]
        with self.assertRaises(BoardLedgerInvalidError):
            await self.save(Scene(**second, support_department_ids=[], asset_keys=["assistant:foreign"]))
        self.assertEqual((await self.item("scene"))["version"], scene["version"])
        await self.save(Scene(**second, support_department_ids=[3], asset_keys=[]))
        cleared = await self.item("scene")
        self.assertEqual(cleared["asset_keys"], [])
        self.assertEqual([s["department"] for s in cleared["supports"]], [3])
        self.assertEqual(await managed_scene_assets(1, date(2025, 9, 1)), {scene["id"]: []})
        self.assertEqual(await managed_scene_assets(1, date(2024, 12, 31)), {})
        with self.assertRaises(ValidationError):
            Scene(**basic, support_department_ids=[1])

    async def test_release_and_reuse_legacy_links_can_be_retained_then_cleared(self):
        await self.save(Topic(kind="topic", name="Services"))
        basic = dict(kind="scene", name="Invoices", topic_id=(await self.item("topic"))["id"],
                     department_id=1, planned_date="2025-02-01")
        await self.save(Scene(**basic))
        scene = await self.item("scene")
        released = {"kind": "release", "asset_key": "assistant:a", "effective_date": date(2025, 3, 1),
                    "parent_id": scene["id"]}
        async with self.session() as db:
            db.add(BoardSupplement(id=str(uuid4()), tenant_id=1, operator_id=1, year=2025, revision=1,
                                   kind="scene-asset", parent_id=scene["id"], name="Reuse",
                                   business_date=date(2025, 3, 2), recorded_at=datetime(2025, 3, 2),
                                   payload='{"asset":"knowledge:2"}'))
            await db.commit()
        legacy = await legacy_scene_assets(1, date(2025, 4, 1), [released], [])
        expected = {"assistant:a", "knowledge:2"}
        self.assertEqual(legacy[scene["id"]], expected)
        unchanged = Scene(**basic, id=scene["id"], version=scene["version"], asset_keys=sorted(expected))
        await planning.save_plan(1, 20, 2025, unchanged, inherited_assets=expected)
        self.assertEqual(await managed_scene_assets(1, None), {})
        updated = Scene(**basic, id=scene["id"], version=(await self.item("scene"))["version"], asset_keys=[])
        await planning.save_plan(1, 20, 2025, updated, inherited_assets=expected)
        self.assertEqual(await managed_scene_assets(1, None), {scene["id"]: []})

    async def test_historical_asset_edit_reassigns_the_legacy_scene(self):
        release = {"kind": "release", "asset_key": "assistant:a", "parent_id": "old",
                   "effective_date": date(2025, 2, 1)}
        catalog = [{"id": "assistant:a"}]
        projection = "bisheng.company_board.domain.repositories.asset_projection."
        self.enterContext(patch(projection + "list_ledger", return_value=[]))
        self.enterContext(patch(projection + "load_catalog", return_value=([], catalog)))
        async with self.session() as db:
            db.add(BoardSupplement(id=str(uuid4()), tenant_id=1, operator_id=1, year=2025, revision=1,
                                   kind="asset-binding", parent_id="assistant:a", name="A",
                                   recorded_at=datetime(2025, 5, 1), business_date=date(2025, 5, 1),
                                   payload=json.dumps({"topic": "a", "topic_name": "A", "case_name": "",
                                                       "scenes": ["new"]})))
            await db.commit()
        self.assertEqual(await legacy_scene_assets(1, date(2025, 4, 30), [release], catalog),
                         {"old": {"assistant:a"}})
        self.assertEqual(await legacy_scene_assets(1, date(2025, 5, 1), [release], catalog),
                         {"new": {"assistant:a"}})

    async def test_scene_case_links_can_be_removed_and_support_unit_can_be_renewed(self):
        await self.save(Topic(kind="topic", name="Supply chain"))
        topic = await self.item("topic")
        basic = dict(kind="scene", name="Reconciliation", topic_id=topic["id"],
                     department_id=1, planned_date="2025-03-01")
        await self.save(Scene(**basic, supports=[{"department": 2, "start": "2025-03-01", "end": "2026-01-01"}]))
        scene = await self.item("scene")
        async with self.session() as db:
            db.add(BoardSupplement(id=str(uuid4()), tenant_id=1, operator_id=1, year=2025, revision=1,
                                   kind="case", parent_id=topic["id"], name="Reconciliation example",
                                   recorded_at=datetime(2025, 3, 2), business_date=date(2025, 3, 2),
                                   payload=json.dumps({"scene": scene["id"],
                                                       "assets": "assistant:7, knowledge:5,assistant:7, "})))
            await db.commit()
        cutoff = date(2025, 12, 31)
        inherited = await legacy_scene_assets(1, cutoff, [], [])
        self.assertEqual(inherited[scene["id"]], {"assistant:7", "knowledge:5"})
        links = await legacy_scene_links(1, cutoff)
        self.assertEqual([(r["source"], r["parent_id"], r["fields"]["asset"]) for r in links],
                         [("case", scene["id"], "assistant:7"), ("case", scene["id"], "knowledge:5")])
        self.assertEqual(await legacy_scene_links(1, date(2025, 3, 1)), [])
        update = Scene(**basic, id=scene["id"], version=scene["version"], asset_keys=[], support_department_ids=[2])
        await planning.save_plan(1, 20, 2025, update, inherited_assets=inherited[scene["id"]])
        self.assertEqual(await managed_scene_assets(1, cutoff), {scene["id"]: []})
        saved = await self.item("scene")
        self.assertEqual([(s["department"], s["start"], s["end"]) for s in saved["supports"]],
                         [(2, date(2025, 3, 1), None)])

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
        self.assertEqual((row["name"], row["target"]), ("未归类", 1))
        edit = dict(id=row["id"], version=row["version"], name="装备维保", target=5, planned_date="2025-06-01")
        await self.save(Collection(kind="collection", **edit))
        current = await self.item("collection")
        self.assertEqual((current["id"], current["name"], current["target"]), (row["id"], "装备维保", 5))
        with self.assertRaises(BoardLedgerConflictError):
            await self.save(Collection(kind="collection", **edit))
        with self.assertRaises(BoardLedgerInvalidError):
            await self.save(Collection(kind="collection", name="装备维保", target=1, planned_date="2025-08-01"))
        self.assertEqual(len(await planning.knowledge_targets(1, 2025)), 1)
        self.assertEqual(await planning.knowledge_targets(2, 2025), [])
        await planning.save_plan(1, 20, 2026, Collection(kind="collection", name="装备维保", target=0, planned_date="2026-05-01"))
        self.assertEqual((await planning.knowledge_targets(1, 2026))[0]["id"], row["id"])
        async with self.session() as db:
            self.assertIsNotNone(await db.get(BoardLedger, (1, collection_id, 1)))
        with self.assertRaises(BoardLedgerInvalidError):
            await self.save(Collection(kind="collection", name="法务", target=3, planned_date="2026-06-01"))
