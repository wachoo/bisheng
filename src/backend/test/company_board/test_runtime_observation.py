"""Controlled assistant Web turns against a private in-memory SQLite database."""

from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, Mock, patch

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from bisheng.api.services.assistant_agent import AssistantAgent
from bisheng.api.services.assistant_skills import bind_skill_tools
from bisheng.common.board_observation import BoardObservation, current_observation
from bisheng.common.chat.client import ChatClient
from bisheng.common.constants.enums.telemetry import ApplicationTypeEnum, StatusEnum
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.services.runtime import WebAssistantObservation, read_runtime, save_observation
from bisheng.core.context.tenant import current_tenant_id
from bisheng.core.database.tenant_filter import register_tenant_filter_events
from bisheng.database.models.assistant import AssistantStatus
from bisheng.database.models.department import Department
from bisheng.tool.domain.services.executor import ToolExecutor, _result_status


class WorkTimeTests(TestCase):
    def test_only_complete_model_receipts_contribute_tokens(self):
        turn = BoardObservation("employee", 8)
        for call, usage in (
            ("both", {"prompt_tokens": 600, "completion_tokens": 400}),
            ("absent", {}),
            ("input-only", {"prompt_tokens": 900}),
        ):
            turn.on_llm_start({}, [], run_id=call)
            turn.on_llm_end(SimpleNamespace(llm_output={"token_usage": usage}, generations=[]), run_id=call)
        self.assertEqual(turn.tokens, {"both": (600, 400)})
        metered_calls = [
            op for (kind, _, op), (status, _) in turn.facts.items()
            if kind == "model" and status == "metered"
        ]
        self.assertEqual(metered_calls, ["both"])

    def test_pure_wait_and_parallel_inference(self):
        clock = Mock(side_effect=[0, 10, 20, 30, 40, 45, 48, 60])
        turn = BoardObservation("employee", 8, clock=clock)
        turn.start()
        turn.on_tool_start({}, "", run_id="A")
        turn.on_tool_start({}, "", run_id="B")
        turn.on_llm_start({}, [], run_id="C")
        turn.on_tool_end("", run_id="A")
        turn.on_tool_end("", run_id="B")
        turn.on_llm_end(None, run_id="C")
        self.assertEqual(turn.finish(), 40)

    def test_mcp_failure_return_is_not_success(self):
        tool = SimpleNamespace(tool_is_preset=2, tool_key="")
        for failure in ('{"isError":true}', "Tool call failed: unavailable"):
            self.assertEqual(_result_status(tool, failure), StatusEnum.FAILED)
        self.assertEqual(_result_status(tool, '{"isError":false}'), StatusEnum.SUCCESS)


class LocalWebRuntimeTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tenant_token = current_tenant_id.set(51)
        self.addCleanup(current_tenant_id.reset, self.tenant_token)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as conn:
            await conn.run_sync(BoardRuntimeEvent.__table__.create)
            await conn.run_sync(Department.__table__.create)
        register_tenant_filter_events()

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        self.enterContext(patch("bisheng.company_board.domain.repositories.runtime.get_async_db_session", session))
        self.enterContext(patch("bisheng.company_board.domain.repositories.planning_departments.get_async_db_session", session))
        async with session() as db:
            db.add_all([
                Department(id=1, tenant_id=51, dept_id="company", name="葛洲坝供应链公司"),
                Department(id=114, tenant_id=51, dept_id="unit", name="采购中心", parent_id=1),
                Department(id=115, tenant_id=51, dept_id="group", name="询价组", parent_id=114),
            ])
            await db.commit()
        self.enterContext(
            patch("bisheng.company_board.domain.services.runtime.primary_department", AsyncMock(return_value=115))
        )

    async def query(self):
        return await read_runtime(51, datetime(2000, 1, 1), datetime(2100, 1, 1))

    async def dated_output(self, link, day, *, project=""):
        turn = BoardObservation("one", 7)
        turn.record_outputs({"file_list": [link]})
        self.assertEqual(turn.register_outputs([link], project, "1" if project else ""), "Delivery recorded.")
        at = datetime(2026, 11, day, 3)  # UTC; 11 AM in Beijing.
        turn.facts = {key: (status, at) for key, (status, _) in turn.facts.items()}
        await save_observation(turn, "success", None)

    async def as_of(self, day):
        return await read_runtime(51, datetime(2026, 11, 1), datetime(2026, 11, day))

    async def test_later_membership_preserves_earlier_report(self):
        link = "/bucket/stable-file"
        # Later run finishes first. Accounting still follows the actual formation timestamps.
        await self.dated_output(link, 12, project="reuse")
        await self.dated_output(link, 9)
        before, after = await self.as_of(11), await self.as_of(13)
        self.assertEqual((before["file_outputs"], before["code_versions"], before["deliverables"]), (1, 0, 1))
        self.assertEqual((after["file_outputs"], after["code_versions"], after["deliverables"]), (0, 1, 1))

    async def test_version_member_later_published_as_file(self):
        link = "/bucket/stable-file"
        await self.dated_output(link, 9, project="reuse")
        await self.dated_output(link, 12)
        before, after = await self.as_of(11), await self.as_of(13)
        for summary in (before, after):
            self.assertEqual((summary["file_outputs"], summary["code_versions"], summary["deliverables"]), (0, 1, 1))

    async def test_web_handshake_caches_delivery_tool_and_validates_each_turn(self):
        async def create(file: str):
            """Produce an artifact in the test interpreter."""
            return {"file_list": [file]}

        underlying = StructuredTool.from_function(coroutine=create, name="bisheng_code_interpreter")
        tool = ToolExecutor.init_by_tool_instance(
            underlying,
            SimpleNamespace(id=7, name="interpreter", is_preset=1, tool_key="bisheng_code_interpreter"),
            app_id="asset",
            app_name="demo",
            app_type=ApplicationTypeEnum.ASSISTANT,
            user_id=7,
        )
        client = object.__new__(ChatClient)
        client.kwargs = {"board_sink": WebAssistantObservation.begin}
        client.client_key, client.client_id, client.chat_id, client.user_id = "test", "asset", "web-session", 7
        client.init_chat_history = AsyncMock()

        async def callbacks():
            client.gpts_async_callback = []

        client.init_gpts_callback = callbacks
        client.gpts_async_callback = []
        client.get_latest_history = AsyncMock(return_value=[])
        client.add_message = AsyncMock(return_value=None)
        client.send_response, client.websocket, client.generate_session_title = AsyncMock(), AsyncMock(), AsyncMock()
        client.finalizing_tasks, client.background_tasks = set(), set()
        assistant = SimpleNamespace(id="asset", name="demo", status=AssistantStatus.ONLINE.value, skill_ids=[])
        self.enterContext(patch("bisheng.common.chat.client.AssistantDao.get_one_assistant", return_value=assistant))
        self.enterContext(patch.object(AssistantAgent, "init_llm", AsyncMock()))
        self.enterContext(patch.object(AssistantAgent, "init_agent", AsyncMock()))
        self.enterContext(
            patch(
                "bisheng.api.services.assistant_agent.AssistantLinkDao.get_assistant_link",
                AsyncMock(return_value=[SimpleNamespace(tool_id=7)]),
            )
        )
        self.enterContext(patch.object(ToolExecutor, "init_by_tool_ids", AsyncMock(side_effect=lambda *a, **k: [tool])))
        self.enterContext(patch.object(ToolExecutor, "_require_current_use", AsyncMock()))
        self.enterContext(
            patch("bisheng.tool.domain.services.executor.UserToolAvailabilityService.ensure_enabled", AsyncMock())
        )
        self.enterContext(patch("bisheng.tool.domain.services.executor.telemetry_service.log_event", AsyncMock()))
        self.enterContext(patch("bisheng.common.chat.client.save_message_citations", AsyncMock()))
        await client.handle_gpts_message({"inputs": {"data": {"id": "asset", "chatId": "web-session"}}})
        agent = client.gpts_agent
        self.assertIsNotNone(agent)
        registered = {item.name: item for item in agent.tools}
        self.assertIn("register_assistant_delivery", registered)
        results = []

        async def respond(prompt, history, callbacks):
            config = {"callbacks": callbacks}
            link = "/private/test/" + prompt
            await registered["bisheng_code_interpreter"].ainvoke({"file": link}, config=config)
            deliver = registered["register_assistant_delivery"]
            results.append(await deliver.ainvoke({"file_links": [link]}, config=config))
            if prompt == "b":
                results.append(await deliver.ainvoke({"file_links": ["/private/test/a"]}, config=config))
                results.append(await deliver.ainvoke({"file_links": ["https://forged/private/test/b"]}, config=config))
            return [AIMessage(content="ok")]

        agent.run = respond
        for prompt in ("a", "b"):
            await client.handle_gpts_message({"inputs": {"input": prompt}})
            self.assertIs(client.gpts_agent, agent)
        self.assertEqual(results[:2], ["Delivery recorded."] * 2)
        self.assertNotIn("Delivery recorded.", results[2:])
        summary = await self.query()
        self.assertEqual((summary["file_outputs"], summary["tool_success"], summary["successful_tasks"]), (2, 2, 2))

    def web_chat_client(self):
        client = object.__new__(ChatClient)
        client.kwargs = {"board_sink": WebAssistantObservation.begin}
        client.client_key, client.client_id, client.chat_id, client.user_id = "test", "asset", "web-session", 7
        client.init_gpts_agent = AsyncMock()
        client.db_assistant = SimpleNamespace(status=AssistantStatus.ONLINE.value)
        client.get_latest_history = AsyncMock(return_value=[])
        client.add_message = AsyncMock(return_value=SimpleNamespace(id=9001))
        client.send_response, client.websocket, client.generate_session_title = AsyncMock(), AsyncMock(), AsyncMock()
        client.finalizing_tasks, client.background_tasks = set(), set()
        client.gpts_async_callback = []
        client.gpts_agent = Mock()
        client.gpts_agent.llm.streaming = False
        client.gpts_agent.collect_citation_registry_items.return_value = []
        model = FakeListChatModel(responses=["ok"])

        async def respond(prompt, history, callbacks):
            response = await model.ainvoke(prompt, config={"callbacks": callbacks})
            if prompt == "fail":
                raise RuntimeError("controlled test failure")
            return [response]

        client.gpts_agent.run = respond
        return client

    async def test_real_turn_handler_counts_both_outcomes_and_excludes_preview(self):
        client = self.web_chat_client()
        with patch("bisheng.common.chat.client.save_message_citations", AsyncMock()):
            await client.handle_gpts_message({"inputs": {"input": "success"}})
            await client.handle_gpts_message({"inputs": {"input": "fail"}})
            client.chat_id = ""
            await client.handle_gpts_message({"inputs": {"input": "debug"}})
        summary = await self.query()
        self.assertEqual((summary["successful_tasks"], summary["failed_tasks"], summary["timed_tasks"]), (1, 1, 2))
        self.assertEqual(summary["department_usage"], [{"department_id": 114, "count": 1}])
        self.assertGreater(summary["active_seconds"], 0)
        self.assertIsNone(summary["timing_coverage"])
        self.assertEqual(summary["usage"], [{"kind": "employee", "asset_id": "assistant:asset", "count": 1}])

    async def test_runtime_insert_failure_preserves_reply_but_drops_that_turn(self):
        client = self.web_chat_client()
        async with self.engine.begin() as conn:
            await conn.exec_driver_sql(
                "CREATE TRIGGER reject_events BEFORE INSERT ON board_runtime_event "
                "BEGIN SELECT RAISE(ABORT, 'controlled write failure'); END"
            )
        self.enterContext(patch("bisheng.common.chat.client.save_message_citations", AsyncMock()))
        with patch("bisheng.company_board.domain.services.runtime.logger") as log:
            await client.handle_gpts_message({"inputs": {"input": "during outage"}})
            log.exception.assert_called_once()
        replies = [call.args for call in client.send_response.await_args_list]
        self.assertIn(("answer", "end", "ok"), replies)
        self.assertEqual((await self.query())["observed_runs"], 0)

        async with self.engine.begin() as conn:
            await conn.exec_driver_sql("DROP TRIGGER reject_events")
        await client.handle_gpts_message({"inputs": {"input": "after recovery"}})
        self.assertEqual((await self.query())["successful_tasks"], 1)

    async def test_actual_skill_and_version_replay(self):
        turn = BoardObservation("one", 7)
        token = current_observation.set(turn)
        self.addCleanup(current_observation.reset, token)
        row = SimpleNamespace(
            name="bisheng-docx",
            display_name="Word",
            description="docs",
            content_hash="1",
            owner_user_id=0,
            tenant_id=51,
            id=42,
        )
        tools = []
        with patch("bisheng.api.services.assistant_skills.SkillStore") as store:
            store.return_value.read_text.return_value = "instructions"
            await bind_skill_tools([row], tools)
            self.assertEqual(turn.facts, {})
            await tools[-1].ainvoke({"name": row.name})
            self.assertEqual(turn.facts, {})
            await tools[-2].ainvoke({"name": row.name})
        links = [f"/bucket/{n}" for n in ("table.csv", "report.docx", "report.pdf", "main.py", "app.js")]
        turn.record_outputs({"file_list": links})
        self.assertEqual(sum(kind == "file" for kind, _, _ in turn.facts), 3)
        self.assertEqual(turn.register_outputs(links[-2:], "project-X", "v1"), "Delivery recorded.")
        self.assertNotEqual(turn.register_outputs(["/invalid"], "project-X", "v2"), "Delivery recorded.")
        await save_observation(turn, "failed", None)
        await save_observation(turn, "failed", None)
        second = BoardObservation("another-assistant", 12)
        second.record_outputs({"file_list": ["/bucket/pkg.zip"]})
        second.register_outputs(["/bucket/pkg.zip"], "project-X", "v1")
        await save_observation(second, "success", 2)
        summary = await self.query()
        self.assertEqual(
            (summary["skill_calls"], summary["file_outputs"], summary["code_versions"], summary["deliverables"]),
            (1, 3, 1, 4),
        )
        other = current_tenant_id.set(52)
        try:
            hidden = await read_runtime(52, datetime(2000, 1, 1), datetime(2100, 1, 1))
            self.assertEqual(hidden["recent_runs"], [])
            self.assertIsNone(hidden["deliverables"])
        finally:
            current_tenant_id.reset(other)
