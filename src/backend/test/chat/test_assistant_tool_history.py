"""Replay completed assistant turns in insertion order across reload and token trimming."""

import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.chat_agent_executor import _validate_chat_history

from bisheng.api.services.assistant_agent import AssistantAgent
from bisheng.common.chat.client import ChatClient
from bisheng.database.models.message import ChatMessageDao


def call(call_id):
    return AIMessage(content="call", tool_calls=[{"name": "lookup", "args": {}, "id": call_id}])


def row(category, message, remark=""):
    return SimpleNamespace(category=category, message=message, remark=remark)


class AssistantToolHistoryTest(IsolatedAsyncioTestCase):
    async def test_reload_with_tied_timestamps_and_unanswered_questions(self):
        # aget_messages_by_chat_id already orders by (create_time, id) ASC.
        # The beginning of a limited history window can fall inside a turn.
        database_rows = [
            row("tool_result", ToolMessage(content="old result", tool_call_id="old").model_dump_json()),
            row("answer", "outside the window"),
            row("question", json.dumps({"input": "original"})),
            row("tool_call", call("one").model_dump_json()),
            row("tool_result", ToolMessage(content="first", tool_call_id="one").model_dump_json()),
            row("tool_call", call("two").model_dump_json()),
            row("tool_result", ToolMessage(content="second", tool_call_id="two").model_dump_json()),
            row("answer", "complete"),
            row("question", json.dumps({"input": "failed request"})),
            row("question", json.dumps({"input": "retry"})),
        ]
        client = object.__new__(ChatClient)
        client.chat_id, client.chat_history, client.latest_history_num = "test", [], 10
        with patch.object(ChatMessageDao, "aget_messages_by_chat_id", AsyncMock(return_value=database_rows)):
            await client.init_chat_history()
        messages = await client.get_latest_history()
        self.assertEqual(
            [message.content for message in messages], ["original", "call", "first", "call", "second", "complete"]
        )
        _validate_chat_history(messages)

    async def test_token_limit_cannot_separate_parallel_results_from_their_call(self):
        agent = object.__new__(AssistantAgent)
        agent.assistant = SimpleNamespace(max_token=9)
        agent.cl100k_base = lambda: SimpleNamespace(encode=list)
        inputs = [
            HumanMessage(content="previous"),
            AIMessage(content="call", tool_calls=[{"name": "lookup", "args": {}, "id": i} for i in ("one", "two")]),
            ToolMessage(content="aaa", tool_call_id="one"),
            ToolMessage(content="bbb", tool_call_id="two"),
            AIMessage(content="end"),
            HumanMessage(content="new"),
        ]
        self.assertEqual(await agent.trim_messages(inputs), inputs[-2:])
        agent.cl100k_base = Mock(side_effect=AssertionError("single current question needs no truncation"))
        self.assertEqual(await agent.trim_messages(inputs[-1:]), inputs[-1:])

    async def test_trimmed_model_inputs_do_not_shift_the_new_turn_persistence_boundary(self):
        client = object.__new__(ChatClient)
        client.gpts_async_callback = []
        client.init_gpts_agent = AsyncMock()
        client.get_latest_history = AsyncMock(return_value=[HumanMessage(content="q"), AIMessage(content="a")] * 4)
        client.add_message = AsyncMock(return_value=None)
        client.send_response = AsyncMock()
        client.generate_session_title = AsyncMock()
        client.finalizing_tasks, client.background_tasks = set(), set()
        client.client_key, client.client_id, client.chat_id = "key", "app", ""
        client.gpts_agent = Mock()
        client.gpts_agent.collect_citation_registry_items.return_value = []
        client.gpts_agent.run = AsyncMock(
            return_value=[
                HumanMessage(content="new"),
                call("new"),
                ToolMessage(content="found", tool_call_id="new"),
                AIMessage(content="yes"),
            ]
        )
        with patch("bisheng.common.chat.client.save_message_citations", AsyncMock()):
            await client.handle_gpts_message({"inputs": {"input": "new"}})
        saved = [args.args[2] for args in client.add_message.await_args_list]
        self.assertEqual(saved, ["question", "tool_call", "tool_result", "reasoning_answer", "answer"])
