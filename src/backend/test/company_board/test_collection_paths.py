"""Replay dashboard collection from published route handlers, without network services.

Set BOARD_COLLECTION_REPORT to write the per-call evidence and dashboard counters.
Authentication, assistant models, message storage and queue transport are local doubles.
Workflow samples execute the production worker and a real start-to-end graph.
"""

import asyncio
import json
import os
from contextlib import ExitStack, asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch

from langchain_core.messages import AIMessage
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from starlette.requests import Request
from starlette.websockets import WebSocketDisconnect

from bisheng.api.v1 import assistant as web_assistant
from bisheng.api.v1 import workflow as web_workflow
from bisheng.assistant.domain.services import published_assistant_service as assistant_service
from bisheng.common.chat.client import ChatClient
from bisheng.common.chat.clients import workflow_client
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.services.runtime import read_runtime
from bisheng.company_board.domain.services.scene_usage import annual_service
from bisheng.core.context.tenant import current_tenant_id
from bisheng.core.database.tenant_filter import register_tenant_filter_events
from bisheng.database.models.assistant import AssistantStatus
from bisheng.database.models.flow import FlowStatus
from bisheng.open_api.domain.context import OpenApiPrincipal
from bisheng.open_endpoints.api.endpoints import assistant as open_assistant
from bisheng.open_endpoints.api.endpoints import workflow as open_workflow
from bisheng.worker.workflow import tasks
from bisheng.workflow.callback.base_callback import BaseCallback
from bisheng.workflow.common.workflow import WorkflowStatus
from bisheng.workflow.domain.services import published_workflow_service as workflow_service

TENANT = 51
A, B, FLOW = (f"{n:032x}" for n in (10, 11, 12))
# entry, asset, user, business outcome, inclusion under the business definition
CASES = [
    ("web_assistant", A, 71, "success", True),
    ("web_assistant", A, 71, "success", True),
    ("web_assistant", A, 72, "success", True),
    ("web_assistant", B, 71, "success", True),
    ("web_assistant", A, 72, "failed", True),
    ("preview_assistant", A, 73, "success", False),
    ("open_assistant", A, 73, "success", True),
    ("web_workflow", FLOW, 73, "success", True),
    ("open_workflow", FLOW, 74, "success", True),
]
START_PARAMS = [
    {"key": k, "value": v} for k, v in (("guide_word", ""), ("guide_question", []), ("preset_question", []))
]
GRAPH = {
    "nodes": [
        {
            "data": {
                "id": "start_1",
                "type": "start",
                "name": "Start",
                "v": 1,
                "group_params": [{"params": START_PARAMS}],
            }
        },
        {"data": {"id": "end_1", "type": "end", "name": "End", "v": 1, "group_params": []}},
    ],
    "edges": [{"id": "edge", "source": "start_1", "sourceHandle": "right", "target": "end_1", "targetHandle": "left"}],
}


class LocalWorkflowTransport(BaseCallback):
    """One in-memory Redis callback for each queue job, shared by route and worker."""

    def __init__(self):
        self.states = []
        self.nodes = []
        self.graph = None
        self.status = None

    def set_workflow_data(self, data, override=None):
        self.graph = data

    def get_workflow_data(self):
        return self.graph

    def set_workflow_status(self, status, reason=""):
        self.status = {"status": status, "reason": reason}
        self.states.append(status)

    def get_workflow_status(self):
        return self.status

    async def async_set_workflow_data(self, data):
        self.set_workflow_data(data)

    async def async_set_workflow_status(self, status):
        self.set_workflow_status(status)

    async def async_get_workflow_status(self):
        return self.status

    async def async_clear_workflow_status(self):
        self.status = None

    async def get_response_until_break(self):
        for message in ():  # This graph has no chat output.
            yield message

    def on_node_end(self, data):
        self.nodes.append(data.node_id)


class CollectionPathTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        token = current_tenant_id.set(TENANT)
        self.addCleanup(current_tenant_id.reset, token)
        self.engine = create_async_engine("sqlite+aiosqlite://")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as conn:
            await conn.run_sync(BoardRuntimeEvent.__table__.create)
        register_tenant_filter_events()

        @asynccontextmanager
        async def session():
            async with AsyncSession(self.engine, expire_on_commit=False) as db:
                yield db

        self.session = session
        for module in ("runtime", "scene_usage"):
            self.enterContext(
                patch(f"bisheng.company_board.domain.repositories.{module}.get_async_db_session", session)
            )
        self.enterContext(
            patch("bisheng.company_board.domain.services.runtime.primary_department", AsyncMock(return_value=23))
        )
        self.telemetry = self.enterContext(patch.object(open_assistant.telemetry_service, "log_event", AsyncMock()))
        self.worker_telemetry = self.enterContext(patch.object(tasks.telemetry_service, "log_event_sync"))
        for module in (web_assistant, web_workflow, open_workflow):
            self.enterContext(patch.object(module, "require_business_action", AsyncMock()))
        self.enterContext(patch("bisheng.common.chat.client.settings", Mock(get_from_db=Mock(return_value={}))))
        self.enterContext(patch("bisheng.common.chat.client.save_message_citations", AsyncMock()))
        self.enterContext(patch("bisheng.common.chat.manager.check_business_action", AsyncMock(return_value=True)))
        for lookup in ("AssistantService.get_one_assistant", "WorkFlowService.get_one_workflow_simple_info"):
            self.enterContext(
                patch("bisheng.common.chat.manager." + lookup, AsyncMock(return_value=SimpleNamespace(name="Fixture")))
            )

    async def employee_events(self):
        async with self.session() as db:
            rows = await db.exec(select(BoardRuntimeEvent).where(BoardRuntimeEvent.kind == "employee"))
            return {r.id: (r.asset_id, r.user_id, r.status) for r in rows}

    async def web_assistant(self, entry, asset, operator, outcome):
        wire = AsyncMock()
        complete = asyncio.Event()

        async def sent(category, status, message, **kwargs):
            if (category, status) == ("processing", "close"):
                complete.set()

        output = AsyncMock(side_effect=sent)
        messages = iter([{"inputs": {"input": "fixture request"}}])

        async def receive():
            if message := next(messages, None):
                return message
            await complete.wait()
            raise WebSocketDisconnect(1000)

        wire.receive_json.side_effect = receive

        async def prepare(client):
            client.db_assistant = SimpleNamespace(name="Fixture", status=AssistantStatus.ONLINE.value)
            client.gpts_async_callback = []
            client.gpts_agent = Mock()
            client.gpts_agent.llm.streaming = False
            client.gpts_agent.collect_citation_registry_items.return_value = []
            client.gpts_agent.run = AsyncMock(return_value=[AIMessage(content="fixture answer")])
            if outcome == "failed":
                client.gpts_agent.run.side_effect = RuntimeError("controlled provider failure")

        with (
            patch.object(ChatClient, "init_gpts_agent", prepare),
            patch.object(ChatClient, "get_latest_history", AsyncMock(return_value=[])),
            patch.object(ChatClient, "add_message", AsyncMock(return_value=None)),
            patch.object(ChatClient, "send_response", output),
            patch.object(ChatClient, "generate_session_title", AsyncMock()),
        ):
            await asyncio.wait_for(
                web_assistant.chat(
                    assistant_id=asset,
                    login_user=operator,
                    websocket=wire,
                    chat_id="" if entry == "preview_assistant" else "fixture-session",
                ),
                timeout=8,
            )
        wire.accept.assert_awaited_once()
        self.assertIn(("processing", "close", ""), [c.args for c in output.await_args_list])
        if outcome == "failed":
            self.assertIn(("system", "start", ""), [c.args for c in output.await_args_list])
            return "failed"
        self.assertIn(("answer", "end", "fixture answer"), [c.args for c in output.await_args_list])
        return "success"

    async def open_assistant(self, asset, operator):
        model = Mock()
        model.init_assistant = AsyncMock()
        model.run = AsyncMock(return_value=[AIMessage(content="fixture answer")])
        with (
            patch.object(open_assistant, "get_open_api_operator", return_value=operator),
            patch.object(
                assistant_service.PublishedAssistantService,
                "get_info",
                AsyncMock(return_value=SimpleNamespace(name="A")),
            ),
            patch.object(assistant_service, "AssistantAgent", return_value=model),
        ):
            result = await open_assistant.assistant_chat_completions(
                Request({"type": "http", "headers": [], "client": ("127.0.0.1", 80)}),
                open_assistant.OpenAIChatCompletionReq(
                    model=asset, stream=False, messages=[{"role": "user", "content": "fixture"}]
                ),
            )
        self.assertEqual(result["choices"][0]["message"]["content"], "fixture answer")
        return "success"

    async def workflow(self, entry, asset, operator):
        transport = LocalWorkflowTransport()
        flow = SimpleNamespace(
            id=asset, name="Fixture workflow", status=FlowStatus.ONLINE.value, data=GRAPH, tenant_id=TENANT, user_id=71
        )

        def callback(unique_id, *args, **kwargs):
            transport.unique_id = unique_id
            return transport

        # Synchronously dispatch the real Celery task, including ordinary telemetry.
        def enqueue(args, queue):
            tasks.execute_workflow.run(*args)

        with ExitStack() as stack:
            for module in (workflow_client, workflow_service, tasks):
                stack.enter_context(patch.object(module, "RedisCallback", side_effect=callback))
            stack.enter_context(patch.object(tasks.FlowDao, "get_flow_by_id", return_value=flow))
            stack.enter_context(
                patch.object(tasks.WorkFlowService, "get_one_workflow_simple_info_sync", return_value=flow)
            )
            stack.enter_context(
                patch.object(
                    tasks,
                    "settings",
                    Mock(get_workflow_conf=Mock(return_value=SimpleNamespace(max_steps=10, timeout=5))),
                )
            )
            stack.enter_context(patch("bisheng.open_api.domain.services.execution_context.validate_execution_snapshot"))
            stack.enter_context(
                patch(
                    "bisheng.open_api.domain.services.execution_context.TenantSettingService.get_policy_sync",
                    return_value=SimpleNamespace(data_scope=None),
                )
            )
            stack.enter_context(patch.object(tasks, "_authorize_workflow_use"))
            stack.enter_context(
                patch.object(tasks.workflow_stateful_worker, "find_task_node", AsyncMock(return_value="fixture"))
            )
            stack.enter_context(patch.object(tasks.execute_workflow, "apply_async", side_effect=enqueue))
            for method in (
                "UserDao.get_user",
                "UserRoleDao.get_user_roles",
                "UserGroupDao.get_user_group",
                "UserDepartmentDao.get_user_primary_department",
            ):
                stack.enter_context(patch("bisheng.workflow.nodes.start.start." + method, return_value=None))
            if entry == "open_workflow":
                principal = OpenApiPrincipal(
                    credential_id=1,
                    actor_kind="natural_person",
                    actor_id=operator.user_id,
                    actor_name="fixture",
                    tenant_id=TENANT,
                    resource_owner_user_id=operator.user_id,
                    scopes=frozenset({"workflow:invoke"}),
                    authorization_subject_type="user",
                    authorization_subject_id=operator.user_id,
                    effective_user_id=operator.user_id,
                )
                stack.enter_context(
                    patch.object(open_workflow, "get_current_open_api_principal", return_value=principal)
                )
                stack.enter_context(patch.object(open_workflow, "get_open_api_operator", return_value=operator))
                stack.enter_context(
                    patch.object(
                        workflow_service.PublishedWorkflowService, "get_workflow", AsyncMock(return_value=flow)
                    )
                )
                stack.enter_context(
                    patch.object(
                        workflow_service.ChatSessionService,
                        "get_subject_session_if_exists",
                        AsyncMock(return_value=None),
                    )
                )
                stack.enter_context(
                    patch.object(workflow_service.ChatSessionService, "create_subject_session", AsyncMock())
                )
                result = await open_workflow.invoke_workflow(
                    open_workflow.OpenWorkflowInvokeRequest(workflow_id=asset, stream=False)
                )
                self.assertEqual(
                    [event.event for event in result.data["events"]], [open_workflow.WorkflowEventType.Close.value]
                )
            else:
                output = AsyncMock()

                wire = AsyncMock()
                wire.receive_json.side_effect = [
                    {"action": "init_data", "chat_id": "fixture-flow", "data": GRAPH},
                    WebSocketDisconnect(1000),
                ]
                client = workflow_client.WorkflowClient
                # Await synchronous delivery for this fixture instead of scheduling its thread-pool task.
                stack.enter_context(patch.object(client, "handle_message", client._handle_message))
                stack.enter_context(patch.object(client, "init_history", AsyncMock()))
                stack.enter_context(patch.object(client, "send_response", output))
                await web_workflow.workflow_ws(
                    workflow_id=asset, chat_id="fixture-flow", login_user=operator, websocket=wire
                )
                wire.accept.assert_awaited_once()
                self.assertIn(("processing", "close", ""), [c.args for c in output.await_args_list])
        self.assertEqual(
            transport.states, [WorkflowStatus.WAITING.value, WorkflowStatus.RUNNING.value, WorkflowStatus.SUCCESS.value]
        )
        self.assertEqual(transport.nodes, ["start_1", "end_1"])
        return "success"

    async def test_entry_points_to_annual_scene_service(self):
        observations = []
        for index, (entry, asset, user, outcome, eligible) in enumerate(CASES, 1):
            with self.subTest(index=index, entry=entry):
                before = await self.employee_events()
                self.telemetry.reset_mock()
                self.worker_telemetry.reset_mock()
                operator = SimpleNamespace(user_id=user)
                if entry in ("web_assistant", "preview_assistant"):
                    actual = await self.web_assistant(entry, asset, operator, outcome)
                elif entry == "open_assistant":
                    actual = await self.open_assistant(asset, operator)
                else:
                    actual = await self.workflow(entry, asset, operator)
                self.assertEqual(actual, outcome)
                after = await self.employee_events()
                new = [after[k] for k in after.keys() - before.keys()]
                self.assertEqual(new, [(asset, user, outcome)] if entry == "web_assistant" else [])
                telemetry = [
                    call.kwargs["event_type"].value
                    for call in [*self.telemetry.call_args_list, *self.worker_telemetry.call_args_list]
                ]
                self.assertCountEqual(telemetry, ["application_alive", "application_process"])
                observations.append(
                    {
                        "case": index,
                        "entry": entry,
                        "asset": asset,
                        "user": user,
                        "outcome": actual,
                        "expected_employee_events": int(eligible),
                        "employee_events": len(new),
                        "telemetry": sorted(telemetry),
                    }
                )

        keys = ["assistant:" + A, "assistant:" + B, "flow:" + FLOW]
        catalog = [{"kind": "employee", "id": k, "name": n} for k, n in zip(keys, ("A", "B", "Workflow"), strict=True)]
        entries = [SimpleNamespace(id=i, kind="scene", name=n) for i, n in ((1, "Purchasing"), (2, "Shared"))]
        today = (datetime.utcnow() + timedelta(hours=8)).date()
        year, end = date(today.year, 1, 1), datetime(today.year + 1, 1, 1)
        annual = await annual_service(TENANT, year, end, entries, {1: keys, 2: [keys[0]]}, catalog)
        runtime = await read_runtime(TENANT, datetime.combine(year, datetime.min.time()), end)
        board = {k: runtime[k] for k in ("successful_tasks", "failed_tasks", "timed_tasks")}
        board.update(annual)
        self.assertEqual((board["successful_tasks"], board["failed_tasks"], board["timed_tasks"]), (4, 1, 5))
        self.assertEqual((board["uses"], board["users"]), (4, 2))
        self.assertEqual(
            [(e["uses"], e["users"], len(e["scenes"])) for e in annual["employees"]], [(3, 2, 2), (1, 1, 1), (0, 0, 1)]
        )
        successful = [r for r in observations if r["expected_employee_events"] and r["outcome"] == "success"]
        expected = {"uses": len(successful), "users": len({r["user"] for r in successful})}
        self.assertEqual(expected, {"uses": 7, "users": 4})
        if path := os.environ.get("BOARD_COLLECTION_REPORT"):
            Path(path).write_text(
                json.dumps(
                    {"cases": observations, "business_expected": expected, "board": board}, ensure_ascii=False, indent=2
                )
                + "\n",
                encoding="utf-8",
            )
