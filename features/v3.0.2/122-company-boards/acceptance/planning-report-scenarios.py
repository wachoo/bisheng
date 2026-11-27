"""Run T01, T02, T03 and T10 against the company board HTTP routes and asset DAOs.

Each case uses a fresh temporary SQLite file and an in-process ASGI client.
The login dependency supplies a local administrator. Asset publication, catalog
queries, department attribution, report writes and revisions use application code.

From the repository root, with BACKEND_IMAGE set to the backend image under test:

    docker run --rm -i --network none -e PYTHONPATH=/app --entrypoint sh "$BACKEND_IMAGE" \
        -c 'echo "{}" > /tmp/board.yaml; config=/tmp/board.yaml python -' \
        < features/v3.0.2/122-company-boards/acceptance/planning-report-scenarios.py

With an existing backend Python environment, run the file with src/backend on
PYTHONPATH and the config environment variable pointing to an empty YAML map.
"""

import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import Session
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.company_board.api.router import router
from bisheng.company_board.domain.models.feedback import BoardIssueResolution, BoardRating
from bisheng.company_board.domain.models.ledger import BoardLedger
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.models.supplement import BoardSupplement
from bisheng.company_board.domain.repositories.planning_departments import PLANNING_COMPANY
from bisheng.company_board.domain.repositories.publication import install_publication_tracking
from bisheng.core.context.tenant import tenant_execution_scope
from bisheng.core.database import manager
from bisheng.database.models.app import App
from bisheng.database.models.assistant import Assistant, AssistantDao, AssistantStatus
from bisheng.database.models.audit_log import AuditLog
from bisheng.database.models.department import Department, UserDepartment
from bisheng.database.models.flow import Flow, FlowDao, FlowStatus
from bisheng.knowledge.domain.models.knowledge import Knowledge, KnowledgeDao, KnowledgeState
from bisheng.linsight.domain.models.linsight_skill import LinsightSkill, LinsightSkillDao
from bisheng.tool.domain.models.gpts_tools import GptsTools, GptsToolsDao, GptsToolsType, GptsToolsTypeRead


def evidence(case, **values):
    print(f"{case} {json.dumps(values, ensure_ascii=False)}", flush=True)


class PlanningReportScenarios(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        path = (Path(directory) / "boards.sqlite").as_posix()
        engine = create_engine(f"sqlite:///{path}")
        async_engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
        self.addCleanup(engine.dispose)
        self.addAsyncCleanup(async_engine.dispose)

        # Both generations of asset DAOs use the same file as the async board routes.
        database = SimpleNamespace(
            create_session=lambda: Session(engine, expire_on_commit=False),
            async_session=lambda: AsyncSession(async_engine, expire_on_commit=False),
        )
        self.enterContext(patch.object(manager, "get_database_connection", return_value=database))
        self.enterContext(patch.object(manager, "sync_get_database_connection", return_value=database))
        self.enterContext(tenant_execution_scope(1))
        for model in (
            Department, UserDepartment, Assistant, Flow, Knowledge, LinsightSkill, GptsToolsType,
            GptsTools, App, AuditLog, BoardLedger, BoardSupplement, BoardRuntimeEvent, BoardRating,
            BoardIssueResolution,
        ):
            model.__table__.create(engine)

        with database.create_session() as session:
            for ident, name, parent in (
                (99, PLANNING_COMPANY, None), (15, "集中采购中心", 99), (35, "财务共享中心", 99),
                (36, "运营管理中心", 99), (101, "设备采购组", 15), (102, "材料采购组", 15),
            ):
                session.add(Department(id=ident, dept_id=str(ident), name=name, parent_id=parent, tenant_id=1))
            for user_id, unit in ((1, 101), (2, 102), (3, 35)):
                session.add(UserDepartment(id=user_id, user_id=user_id, department_id=unit, is_primary=1))
            session.commit()
        install_publication_tracking()
        user = UserPayload(user_id=1, user_role=[], tenant_id=1, is_global_super=True)
        app = FastAPI()
        app.include_router(router, prefix="/api/v1")
        app.dependency_overrides[UserPayload.get_login_user] = lambda: user
        self.client = await self.enterAsyncContext(
            AsyncClient(transport=ASGITransport(app=app), base_url="http://board.test/api/v1/company-boards/")
        )
        self.today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        self.year = self.today.year
        self.plan_route = f"planning/{self.year}"
        self.period = {"board": "lead", "year": self.year, "month": self.today.month}

    async def request(self, method, route, *, params=None, data=None):
        response = await self.client.request(method, route, params=params, json=data)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["status_code"], 200, body)
        return body["data"]

    async def overview(self):
        return await self.request("GET", "overview", params=self.period)

    async def save_plan(self, **data):
        await self.request("PUT", self.plan_route, data=data)

    async def test_t01_year_plan(self):
        await self.save_plan(kind="targets", employee=10, scene=4)
        await self.save_plan(kind="topic", name="采购质量提升", is_featured=True)
        await self.save_plan(kind="topic", name="履约风险管控", is_featured=False)
        plan = await self.request("GET", self.plan_route)
        departments = {unit["id"]: unit["name"] for unit in plan["departments"]}
        self.assertEqual(departments, {15: "集中采购中心", 35: "财务共享中心", 36: "运营管理中心"})
        topics = {row["name"]: row["id"] for row in plan["items"] if row["kind"] == "topic"}
        for name, topic, owner, completed in (
            ("设备到货验收", "采购质量提升", 15, self.today.isoformat()),
            ("应收履约核验", "履约风险管控", 35, None),
        ):
            await self.save_plan(
                kind="scene", name=name, topic_id=topics[topic], department_id=owner,
                support_department_ids=[36], planned_date=self.today.isoformat(), completed_date=completed,
            )
        plan = await self.request("GET", self.plan_route)
        scenes = {r["name"]: [r["department_id"], r["support_department_ids"], r["completed_date"]]
                  for r in plan["items"] if r["kind"] == "scene"}
        self.assertEqual(scenes, {"设备到货验收": [15, [36], self.today.isoformat()], "应收履约核验": [35, [36], None]})
        board = await self.overview()
        strategy = board["strategy"]
        self.assertEqual((strategy["employee_target"], strategy["scene_target"]), (10, 4))
        self.assertEqual((strategy["employee_built"], strategy["scene_launched"]), (0, 1))
        featured = [row["name"] for row in board["ledger"] if row.get("is_featured")]
        self.assertEqual(featured, ["采购质量提升"])
        evidence("T01", departments=departments, featured=featured, scenes=scenes,
                 employees=[strategy["employee_built"], strategy["employee_target"]],
                 scenes_launched=[strategy["scene_launched"], strategy["scene_target"]])

    async def category_counts(self):
        plan = await self.request("GET", self.plan_route)
        board = await self.overview()
        self.assertEqual(plan["knowledge_progress"], board["strategy"]["knowledge_categories"])
        return {row["name"]: [row["completed"], row["target"]] for row in plan["knowledge_progress"]}

    async def test_t02_reclassify_one_library(self):
        for name, target in (("采购合规", 2), ("采购技术", 4)):
            await self.save_plan(kind="collection", name=name, target=target, planned_date=self.today.isoformat())
        before = await self.category_counts()
        self.assertEqual(before, {"采购合规": [0, 2], "采购技术": [0, 4]})
        library = await KnowledgeDao.async_insert_one(Knowledge(
            id=701, tenant_id=1, user_id=1, name="到货验收指引", state=KnowledgeState.UNPUBLISHED.value,
        ))
        key = f"knowledge:{library.id}"
        plan = await self.request("GET", self.plan_route)
        ids = {row["name"]: row["id"] for row in plan["knowledge_progress"]}

        async def bind(name, revision):
            await self.request("PUT", f"asset-context/{key}", data={
                "revision": revision, "year": self.year, "knowledge_category_id": ids[name],
            })

        await bind("采购合规", 0)
        draft = await self.category_counts()
        self.assertEqual(draft, {"采购合规": [1, 2], "采购技术": [0, 4]})
        self.assertNotIn(key, [row["id"] for row in (await self.overview())["assets"]])
        await KnowledgeDao.async_update_state(library.id, KnowledgeState.PUBLISHED)
        published = await self.category_counts()
        self.assertEqual(published, draft)
        await bind("采购技术", 1)
        moved = await self.category_counts()
        self.assertEqual(moved, {"采购合规": [0, 2], "采购技术": [1, 4]})
        board = await self.overview()
        catalog = [(a["id"], a["published_at"], a["knowledge_category_name"])
                   for a in board["assets"] if a["kind"] == "knowledge"]
        self.assertEqual(catalog, [(key, self.today.isoformat(), "采购技术")])
        evidence("T02", before=before, draft=draft, published=published, moved=moved, catalog=catalog,
                 cutoff=board["cutoff"])

    async def test_t03_first_publication_by_department(self):
        assistant = AssistantDao.create_assistant(Assistant(
            id="equipment", name="设备验收助手", user_id=1, tenant_id=1, status=AssistantStatus.OFFLINE.value,
        ))
        flow = await FlowDao.aupdate_flow(Flow(
            id="delivery", name="到货校核流程", user_id=2, tenant_id=1, status=FlowStatus.OFFLINE.value,
        ))
        skill = await LinsightSkillDao.create(LinsightSkill(
            id=703, tenant_id=1, created_by=3, name="合同核对规范", description="核对履约情况",
            object_path="supplier-contract", enabled=False,
        ))
        draft = await self.overview()
        self.assertEqual(draft["strategy"]["employee_built"], 0)
        self.assertEqual(draft["runtime"]["observed_runs"], 0)
        self.assertFalse([r for r in draft["ledger"] if r["kind"] == "release"])

        assistant.status = AssistantStatus.ONLINE.value
        AssistantDao.update_assistant(assistant)
        flow.status = FlowStatus.ONLINE.value
        await FlowDao.aupdate_flow(flow)
        self.assertTrue(await LinsightSkillDao.set_enabled(skill.name, True))
        await GptsToolsDao.insert_tool_type(GptsToolsTypeRead(
            tenant_id=1, user_id=3, name="结算查询服务",
            children=[GptsTools(id=704, tenant_id=1, user_id=3, name="对账查询", tool_key="lookup")],
        ))

        first = await self.overview()
        assistant.status = AssistantStatus.OFFLINE.value
        AssistantDao.update_assistant(assistant)
        assistant.status = AssistantStatus.ONLINE.value
        AssistantDao.update_assistant(assistant)
        board = await self.overview()
        rows = [r for r in board["ledger"] if r["kind"] == "release"]
        self.assertEqual(rows, [r for r in first["ledger"] if r["kind"] == "release"])
        owners = {row["asset_key"]: row["department_id"] for row in rows}
        self.assertEqual(len(rows), 4)
        self.assertEqual(owners, {"assistant:equipment": 15, "flow:delivery": 15, "skill:703": 35, "tool:704": 35})
        assets = {a["id"]: a["department_id"] for a in board["assets"]}
        self.assertEqual(assets, owners)
        first_day = self.today.isoformat()
        self.assertTrue(all(row["effective_date"] == first_day for row in rows))
        self.assertTrue(all(a["published_at"] == first_day for a in board["assets"]))
        plan = await self.request("GET", self.plan_route)
        self.assertEqual((first["strategy"]["employee_built"], board["strategy"]["employee_built"], plan["built"]),
                         (2, 2, 2))
        self.assertEqual(board["runtime"]["observed_runs"], 0)
        trends = await self.request("GET", "trends", params=self.period)
        month = next(entry for entry in trends["months"] if entry["month"] == self.today.month)
        self.assertEqual(month["rows"], [])
        evidence("T03", departments=owners, first_published=first_day, built=plan["built"],
                 observed_runs=board["runtime"]["observed_runs"], trend_rows=month["rows"])

    async def test_t10_monthly_research_revisions(self):
        # Choose three consecutive observable months within one reporting year.
        year, last = (self.year, self.today.month) if self.today.month >= 3 else (self.year - 1, 12)
        first, second = last - 2, last - 1
        subject = {"id": str(uuid4()), "name": "到货验收信息识别", "project": "供应链数字化",
                   "ai": True, "start": date(year, 1, 1).isoformat()}

        async def report(month, revision, projects, days, value):
            return await self.request("PUT", "research-report", data={
                "year": year, "month": month, "revision": revision, "subjects": [subject],
                "metrics": {"projects": projects, "equivalent_days": days, "equivalent_value": value},
            })

        initial = await report(first, 0, 5, 3, "0.24")
        following = await report(second, 0, 8, 5, "0.4")
        self.assertEqual((initial["metrics"]["projects"], following["metrics"]["projects"]), (5, 8))
        await report(first, 1, 5, 4, "0.32")
        observed = []
        for month, source_month, revision, projects in ((first, first, 2, 5), (second, second, 1, 8),
                                                        (last, second, 0, 8)):
            row = await self.request("GET", "research-report", params={"board": "lead", "year": year, "month": month})
            self.assertEqual((row["source"], row["source_month"], row["revision"], row["metrics"]["projects"]),
                             ("direct", source_month, revision, projects))
            self.assertEqual(row["subjects"], [{**subject, "end": None}])
            expected_history = [{"month": first, "equivalent_days": "4", "equivalent_value": "0.32"}]
            if month >= second:
                expected_history.append({"month": second, "equivalent_days": "5", "equivalent_value": "0.4"})
            self.assertEqual(row["history"], expected_history)
            observed.append(row)
        evidence("T10", reports=observed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
