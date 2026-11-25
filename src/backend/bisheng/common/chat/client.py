import asyncio
import json
import time
from collections.abc import Callable, Mapping
from copy import copy
from dataclasses import dataclass
from types import MappingProxyType

from fastapi import Request, WebSocket
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from loguru import logger

from bisheng.api.services.assistant_agent import AssistantAgent
from bisheng.api.services.audit_log import AuditLogService
from bisheng.api.v1.callback import AsyncGptsDebugCallbackHandler
from bisheng.api.v1.schemas import ChatMessage, ChatResponse
from bisheng.assistant.domain.services.assistant_turn import AssistantTurn, current_assistant_turn
from bisheng.citation.domain.schemas.citation_schema import CitationRegistryItemSchema
from bisheng.citation.domain.services.citation_prompt_helper import (
    restore_bare_assistant_citations,
    save_message_citations,
    select_registry_items_for_persistence,
    strip_unregistered_citation_markers,
)
from bisheng.common.chat.types import WorkType
from bisheng.common.constants.enums.telemetry import ApplicationTypeEnum, BaseTelemetryTypeEnum
from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.common.errcode import BaseErrorCode
from bisheng.common.errcode.assistant import AssistantDeletedError, AssistantNotOnlineError, AssistantOtherError
from bisheng.common.schemas.telemetry.event_data_schema import ApplicationProcessEventData, NewMessageSessionEventData
from bisheng.common.services import telemetry_service
from bisheng.common.services.config_service import settings
from bisheng.common.utils.title_generator import generate_conversation_title_async
from bisheng.core.logger import trace_id_var
from bisheng.database.models.assistant import AssistantDao, AssistantStatus
from bisheng.database.models.flow import FlowType
from bisheng.database.models.message import ChatMessage as ChatMessageModel
from bisheng.database.models.message import ChatMessageDao
from bisheng.database.models.session import MessageSession, MessageSessionDao
from bisheng.llm.domain import LLMService
from bisheng.utils import get_request_ip
from bisheng_langchain.gpts.message_types import LiberalToolMessage


@dataclass(frozen=True, slots=True)
class ChatMessageExecution:
    operator: UserPayload
    execution_snapshot: Mapping[str, object]
    session_subject: object | None = None

    def __post_init__(self):
        object.__setattr__(self, "execution_snapshot", MappingProxyType(dict(self.execution_snapshot)))


class ChatClient:
    def __init__(
        self,
        request: Request,
        client_key: str,
        client_id: str,
        chat_id: str,
        user_id: int,
        login_user: UserPayload,
        work_type: WorkType,
        websocket: WebSocket,
        **kwargs,
    ):
        self.request = request
        self.client_key = client_key
        self.client_id = client_id
        self.chat_id = chat_id
        self.user_id = user_id
        self.login_user = login_user
        self.work_type = work_type
        self.websocket = websocket
        self.kwargs = kwargs
        self.session_subject = kwargs.get("session_subject")

        # Business Custom Parameters
        self.db_assistant = None
        self.gpts_agent: AssistantAgent | None = None
        self.gpts_async_callback = None
        self.chat_history = []
        self.new_session = None
        # Incoming when talking to the model Full Historical Dialogue Round Count
        self.latest_history_num = 10
        self.gpts_conf = settings.get_from_db("gpts")
        # Each connection owns the generation tasks that its stop request settles.
        self.message_tasks: set[asyncio.Task] = set()
        self.finalizing_tasks: set[asyncio.Task] = set()
        self.background_tasks: set[asyncio.Task] = set()

    async def close(self):
        pass

    async def send_message(self, message: str):
        await self.websocket.send_text(message)

    async def send_json(self, message: ChatMessage):
        await self.websocket.send_json(message.dict())

    async def handle_message(self, message: dict[any, any], *, execution_context: ChatMessageExecution | None = None):
        logger.info(f"client_id={self.client_key} handle_message start, message: {message}")
        if self.work_type == WorkType.GPTS:
            if message.get("action") == "stop":
                await self.stop_handle_message(message)
                return
            worker = self
            if execution_context is not None:
                # Identity-bound agents/callbacks belong to this message, never the shared connection.
                worker = copy(self)
                worker.login_user = execution_context.operator
                worker.user_id = execution_context.operator.user_id
                worker.kwargs = {**self.kwargs, "execution_snapshot": execution_context.execution_snapshot}
                worker.session_subject = execution_context.session_subject
                worker.gpts_agent = None
                worker.gpts_async_callback = None
                worker.db_assistant = None
            task = asyncio.create_task(worker.wrapper_task(worker.handle_gpts_message, message))
            self.message_tasks.add(task)
            task.add_done_callback(self.message_tasks.discard)
            task.add_done_callback(self.finalizing_tasks.discard)
            # Enter the generation's cancellation handler before accepting a stop.
            await asyncio.sleep(0)

    async def wrapper_task(self, fn: Callable, *args, **kwargs):
        start_time = time.time()
        try:
            # Execute Handling Functions
            await fn(*args, **kwargs)
        except Exception:
            logger.exception("handle message error")
        finally:
            end_time = time.time()
            await telemetry_service.log_event(
                user_id=self.user_id,
                event_type=BaseTelemetryTypeEnum.APPLICATION_PROCESS,
                trace_id=trace_id_var.get(),
                event_data=ApplicationProcessEventData(
                    app_id=self.client_id,
                    app_name=self.db_assistant.name if self.db_assistant else "",
                    app_type=ApplicationTypeEnum.ASSISTANT,
                    chat_id=self.chat_id,
                    start_time=int(start_time),
                    end_time=int(end_time),
                    process_time=int((end_time - start_time) * 1000),
                ),
            )

    def message_extra(self, assistant_timeline: list[dict] | None = None) -> str:
        extra = {"client_key": self.client_key}
        if assistant_timeline is not None:
            extra["assistant_timeline"] = assistant_timeline
        return json.dumps(extra, ensure_ascii=False)

    async def add_message(
        self,
        msg_type: str,
        message: str,
        category: str,
        remark: str = "",
        *,
        assistant_timeline: list[dict] | None = None,
    ):
        self.chat_history.append({"category": category, "message": message, "remark": remark})
        if not self.chat_id:
            # debugMode does not need to save history
            return None
        is_bot = 0 if msg_type == "human" else 1
        msg = ChatMessageDao.insert_one(
            ChatMessageModel(
                is_bot=is_bot,
                source=0,
                message=message,
                category=category,
                type=msg_type,
                extra=self.message_extra(assistant_timeline),
                flow_id=self.client_id,
                chat_id=self.chat_id,
                user_id=self.user_id,
                remark=remark,
            )
        )
        # Log Audit Logs, Is New Session
        if len(self.chat_history) <= 1:
            session = MessageSession(
                chat_id=self.chat_id,
                flow_id=self.client_id,
                flow_name=self.db_assistant.name,
                flow_type=FlowType.ASSISTANT.value,
                user_id=self.user_id,
            )
            if self.session_subject is not None:
                session = self.session_subject.stamp(session)
            self.new_session = MessageSessionDao.insert_one(session)

            # RecordTelemetryJournal
            await telemetry_service.log_event(
                user_id=self.user_id,
                event_type=BaseTelemetryTypeEnum.NEW_MESSAGE_SESSION,
                trace_id=trace_id_var.get(),
                event_data=NewMessageSessionEventData(
                    session_id=self.chat_id,
                    app_id=self.client_id,
                    source="platform",
                    app_name=self.db_assistant.name,
                    app_type=ApplicationTypeEnum.ASSISTANT,
                ),
            )
            AuditLogService.create_chat_assistant(self.login_user, get_request_ip(self.request), self.client_id)
        return msg

    async def send_response(
        self,
        category: str,
        msg_type: str,
        message: str,
        intermediate_steps: str = "",
        message_id: int | None = None,
        citation_registry_items: list[CitationRegistryItemSchema] | None = None,
        citations: list[CitationRegistryItemSchema] | None = None,
        assistant_timeline: list[dict] | None = None,
    ):
        is_bot = 0 if msg_type == "human" else 1
        if citations is None:
            citations = citation_registry_items
        await self.send_json(
            ChatResponse(
                message_id=message_id,
                category=category,
                type=msg_type,
                is_bot=is_bot,
                message=message,
                user_id=self.user_id,
                flow_id=self.client_id,
                chat_id=self.chat_id,
                extra=self.message_extra(assistant_timeline),
                intermediate_steps=intermediate_steps,
                citations=citations,
                citation_registry_items=citation_registry_items,
            )
        )

    async def init_gpts_agent(self):
        await self.init_chat_history()
        await self.init_gpts_callback()
        try:
            # Processing Intelligent Assistant Business
            if self.chat_id and self.gpts_agent is None:
                # Conversation businessagentFixed generation from database data,Don't change every time
                assistant = AssistantDao.get_one_assistant(self.client_id)
                if not assistant:
                    raise AssistantDeletedError()
                    # Under JudgmentagentOnline or not
                if assistant.status != AssistantStatus.ONLINE.value:
                    raise AssistantNotOnlineError()
            elif not self.chat_id:
                # The debug interface is regenerated without testing
                assistant = AssistantDao.get_one_assistant(self.client_id)
                if not assistant:
                    raise AssistantDeletedError()

            # await self.websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=str(e))
            # raise IgnoreException(f'get assistant info error: {str(e)}')

            if self.chat_id and self.gpts_agent is None:
                self.db_assistant = assistant
                # Conversation businessagentFixed generation from database data,Don't change every time
                self.gpts_agent = AssistantAgent(assistant, self.chat_id, invoke_user_id=self.user_id)
                await self.gpts_agent.init_assistant(self.gpts_async_callback)
            elif not self.chat_id:
                self.db_assistant = assistant
                # The debugging interface is regenerated every time
                self.gpts_agent = AssistantAgent(assistant, self.chat_id, invoke_user_id=self.user_id)
                await self.gpts_agent.init_assistant(self.gpts_async_callback)

        except BaseErrorCode as e:
            logger.exception("get assistant info error")
            raise e
        except Exception as e:
            logger.exception("get assistant info error")
            raise AssistantOtherError(exception=e)

    async def init_chat_history(self):
        # Initialization history, not empty or no reinitialization
        if len(self.chat_history) > 0:
            return
        # Load Historical Sessions from Database
        if self.chat_id:
            res = await ChatMessageDao.aget_messages_by_chat_id(
                self.chat_id, ["question", "answer", "tool_call", "tool_result"], self.latest_history_num * 4
            )
            for one in res:
                self.chat_history.append({"message": one.message, "category": one.category, "remark": one.remark})

    async def get_latest_history(self) -> list[BaseMessage]:
        # A limited DB window can begin halfway through a tool exchange, and
        # a failed/stopped turn can end with no usable answer. Only replay
        # exchanges contained between a question and its completed answer.
        turns = []
        answer = None
        tools = []
        for row in reversed(self.chat_history):
            category = row["category"]
            if category == "answer":
                answer = row["message"] if row.get("remark") != "break_answer" else None
                tools = []
            elif category == "question":
                if answer is not None:
                    question = HumanMessage(content=json.loads(row["message"])["input"])
                    turns.append([question, *reversed(tools), AIMessage(content=answer)])
                    if len(turns) == self.latest_history_num:
                        break
                answer = None
                tools = []
            elif answer is not None and category == "tool_call":
                tools.append(AIMessage(**json.loads(row["message"])))
            elif answer is not None and category == "tool_result":
                tools.append(LiberalToolMessage(**json.loads(row["message"])))
        return [message for turn in reversed(turns) for message in turn]

    async def init_gpts_callback(self):
        if self.gpts_async_callback is not None:
            return
        async_callbacks = [
            AsyncGptsDebugCallbackHandler(
                **{
                    "websocket": self.websocket,
                    "flow_id": self.client_id,
                    "chat_id": self.chat_id,
                    "user_id": self.user_id,
                }
            )
        ]
        self.gpts_async_callback = async_callbacks

    async def stop_handle_message(self, message: dict[any, any]):
        tasks = tuple(task for task in self.message_tasks if not task.done())
        for task in tasks:
            if task not in self.finalizing_tasks:
                task.cancel()
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, Exception):
                    logger.opt(exception=result).error("Assistant stop finalization failed for {}", self.client_key)

    async def save_stopped_response(self, turn: AssistantTurn):
        timeline = turn.timeline()
        reasoning = "".join(step["text"] for step in timeline if step["type"] == "reasoning")
        if reasoning:
            res = await self.add_message("bot", reasoning, "reasoning_answer", "break_answer")
            await self.send_response("reasoning_answer", "end", "", message_id=res.id if res else None)
        # An empty answer carries the terminal marker when stopped before the first token.
        res = await self.add_message(
            "bot", "".join(turn.answer_chunks), "answer", "break_answer", assistant_timeline=timeline
        )
        await self.send_response("answer", "end", "", message_id=res.id if res else None, assistant_timeline=timeline)

    async def handle_gpts_message(self, message: dict[any, any]):
        if not message:
            return
        logger.debug(f"receive client message, client_key: {self.client_key} message: {message}")
        question_saved = False
        turn = AssistantTurn()
        turn_token = current_assistant_turn.set(turn)
        try:
            inputs = message.get("inputs", {})
            input_msg = inputs.get("input")
            if not input_msg:
                # Session needs to be switched
                logger.debug(f"need switch agent, client_key: {self.client_key} inputs: {inputs}")
                self.client_id = inputs.get("data").get("id")
                self.chat_id = inputs.get("data").get("chatId")
                self.gpts_agent = None
                self.gpts_async_callback = None
                self.chat_history = []
                await self.init_gpts_agent()
                return

            # Inisialisasiagent
            await self.init_gpts_agent()

            # Write user issue to database
            question_saved = True
            await self.add_message("human", json.dumps(inputs, ensure_ascii=False), "question")
            await self.send_response("processing", "begin", "")

            # Get callback history
            chat_history = await self.get_latest_history()
            self.gpts_agent.reset_citation_registry_items()
            # RecallagentGet Results
            result = await self.gpts_agent.run(input_msg, chat_history, self.gpts_async_callback)
            # Providers may catch cancellation while completing their own cleanup.
            if asyncio.current_task().cancelling():
                raise asyncio.CancelledError
            self.finalizing_tasks.add(asyncio.current_task())
            logger.debug(f"gpts agent {self.client_key} result: {result}")
            answer = result[-1].content

            # Record contains
            # Token trimming may shorten the input history. The current user
            # message in the returned transcript is the actual turn boundary.
            turn_start = next((i + 1 for i in range(len(result) - 2, -1, -1) if isinstance(result[i], HumanMessage)), 0)
            new_history = result[turn_start:-1]
            for one in new_history:
                if isinstance(one, AIMessage):
                    _ = await self.add_message("bot", one.model_dump_json(), "tool_call")
                elif isinstance(one, LiberalToolMessage) or isinstance(one, ToolMessage):
                    _ = await self.add_message("bot", one.model_dump_json(), "tool_result")
                else:
                    logger.warning("unexpected message type")

            answer_end_type = "end"
            # If it's streaming,llmthen useend_coverEnd, Overwrite previous streamed output
            if getattr(self.gpts_agent.llm, "streaming", False):
                answer_end_type = "end_cover"

            timeline = turn.timeline()
            reasoning_content = "".join(step["text"] for step in timeline if step["type"] == "reasoning")

            registered_items = self.gpts_agent.collect_citation_registry_items()
            answer = restore_bare_assistant_citations(answer, registered_items)
            citation_items = select_registry_items_for_persistence(registered_items, answer)
            # A marker the registry cannot back must not reach storage: it would
            # render as a footnote whose detail lookup 404s, reading as a system
            # failure rather than the model having invented the id.
            answer = strip_unregistered_citation_markers(answer, citation_items)

            res = await self.add_message("bot", reasoning_content, "reasoning_answer")
            res = await self.add_message("bot", answer, "answer", assistant_timeline=timeline)
            if res:
                await save_message_citations(
                    message_id=res.id,
                    items=citation_items,
                    chat_id=self.chat_id,
                    flow_id=self.client_id,
                )
            else:
                await save_message_citations(
                    message_id=None,
                    items=citation_items,
                    chat_id=self.chat_id,
                    flow_id=self.client_id,
                )
            await self.send_response("answer", "start", "")
            await self.send_response(
                "answer",
                answer_end_type,
                answer,
                message_id=res.id if res else None,
                citation_registry_items=citation_items,
                citations=citation_items,
                assistant_timeline=timeline,
            )
            logger.info(f"gptsAgentOver assistant_id:{self.client_id} chat_id:{self.chat_id} question:{input_msg}")
            logger.info(f"gptsAgentOver assistant_id:{self.client_id} chat_id:{self.chat_id} answer:{answer}")

            title_task = asyncio.create_task(self.generate_session_title(input_msg))
            self.background_tasks.add(title_task)
            title_task.add_done_callback(self.background_tasks.discard)

        except asyncio.CancelledError:
            self.finalizing_tasks.add(asyncio.current_task())
            if question_saved:
                try:
                    await self.save_stopped_response(turn)
                except Exception as exc:
                    logger.exception("Failed to save stopped assistant response")
                    await AssistantOtherError(exception=exc).websocket_close_message(
                        websocket=self.websocket, close_ws=False
                    )
            raise
        except BaseErrorCode as e:
            logger.exception("handle gpts message error: ")
            await self.send_response("system", "start", "")
            await e.websocket_close_message(websocket=self.websocket, close_ws=False)
        except Exception as e:
            e = AssistantOtherError(exception=e)
            logger.exception("handle gpts message error: ")
            await self.send_response("system", "start", "")
            await e.websocket_close_message(websocket=self.websocket, close_ws=False)
        finally:
            current_assistant_turn.reset(turn_token)
            self.finalizing_tasks.add(asyncio.current_task())
            await self.send_response("processing", "close", "")

    async def generate_session_title(self, question: str):
        if not self.new_session:
            return
        if self.new_session.name:
            return
        self.new_session.name = "New Chat"

        llm_conf = await LLMService.get_workbench_llm()
        if not llm_conf or not llm_conf.chat_title_llm or not llm_conf.chat_title_llm.id:
            return
        llm = await LLMService.get_bisheng_llm(
            model_id=llm_conf.chat_title_llm.id,
            app_id=ApplicationTypeEnum.DAILY_CHAT.value,
            app_name="assistant_chat_title",
            app_type=ApplicationTypeEnum.DAILY_CHAT,
            user_id=self.user_id,
        )
        title = await generate_conversation_title_async(question=question, llm=llm)
        await MessageSessionDao.update_session_name(self.new_session.chat_id, title)
        self.new_session.name = title
