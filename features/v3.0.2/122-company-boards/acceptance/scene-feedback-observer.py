"""Run T06 and T07 against the backend's Web turn handler and board HTTP routes.

From the repository root, in PowerShell, with the backend test image available:

    $probe = (Resolve-Path 'features/v3.0.2/122-company-boards/acceptance/scene-feedback-observer.py').Path
    docker run --rm --network none --mount "type=bind,source=$probe,target=/tmp/probe.py,readonly" --env PYTHONPATH=/app --entrypoint /bin/sh local/company-boards-backend:122 -c 'echo {} > /app/bisheng/config.yaml && /app/.venv/bin/python -B /tmp/probe.py'

The test provides a fixed model reply, authenticated identities, an asset catalog
and an existing chat session. Each case has a private SQLite file for both the
synchronous message DAO and asynchronous observer and reporting repositories.
"""

from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import URL, create_engine
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import Session, select

from bisheng.chat_session.api.endpoints.feedback import router as chat_feedback_router
from bisheng.chat_session.domain.repositories import web_rating
from bisheng.common import board_observation
from bisheng.common.chat.client import ChatClient
from bisheng.common.dependencies.user_deps import UserPayload
from bisheng.company_board.api.router import router as board_router
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.repositories import feedback, planning
from bisheng.company_board.domain.schemas import planning as planning_schema
from bisheng.company_board.domain.services import boards, monitoring, runtime
from bisheng.core.context.tenant import current_tenant_id
from bisheng.core.database.tenant_filter import register_tenant_filter_events
from bisheng.database.models import message as message_store
from bisheng.database.models.department import UserDepartment
from bisheng.database.models.message import ChatMessage
from bisheng.database.models.session import MessageSession
from test.company_board import register_fixture, test_runtime_observation

YEAR = 2026
TENANT = 1
REPORT_TIME = datetime(YEAR, 11, 27, 4)  # All stored event times below are naive UTC.


@contextmanager
def freeze_utc(at, *modules):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            instant = at.replace(tzinfo=UTC)
            return instant.astimezone(tz) if tz else at

    with ExitStack() as patches:
        for module in modules:
            patches.enter_context(patch.object(module, "datetime", Clock))
        yield


def identity(user_id, *, admin=False):
    return SimpleNamespace(user_id=user_id, tenant_id=TENANT, is_admin=lambda: admin, is_global_super=False)


class SceneFeedbackObserverTest(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        url = URL.create("sqlite", database=str(Path(directory) / "board.sqlite"))
        self.engine = create_engine(url)
        self.addCleanup(self.engine.dispose)
        private_async_engine = create_async_engine(url.set(drivername="sqlite+aiosqlite"))
        self.enterContext(patch.object(register_fixture, "engine", private_async_engine))
        for model in (ChatMessage, MessageSession, UserDepartment):
            model.__table__.create(self.engine)

        self.user = identity(9, admin=True)
        app = FastAPI(lifespan=register_fixture.lifespan)
        app.include_router(board_router, prefix="/api/v1")
        app.include_router(chat_feedback_router, prefix="/api/v1")
        app.dependency_overrides[UserPayload.get_login_user] = lambda: self.user
        token = current_tenant_id.set(TENANT)
        self.addCleanup(current_tenant_id.reset, token)
        register_tenant_filter_events()
        self.enterContext(freeze_utc(REPORT_TIME, boards, monitoring, planning, planning_schema, feedback))
        self.enterContext(patch.object(web_rating, "get_sync_db_session", self.session))
        self.enterContext(patch.object(message_store, "get_sync_db_session", self.session))
        self.enterContext(patch("bisheng.common.chat.client.save_message_citations", AsyncMock()))
        self.client = self.enterContext(TestClient(app))
        with self.session() as db:
            for user, department in ((41, 1), (42, 2), (22, 1)):
                db.add(UserDepartment(id=user, user_id=user, department_id=department, is_primary=1))
            db.commit()

    def session(self):
        return Session(self.engine)

    def request(self, method, path, **kwargs):
        response = self.client.request(method, "/api/v1/" + path, **kwargs)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["status_code"], 200, body)
        return body["data"]

    def overview(self, month):
        return self.request("GET", "company-boards/overview", params={"year": YEAR, "month": month, "board": "lead"})

    def observed_turn(self, asset, user, department, at):
        # Use the repository's test model and WebSocket transport. Restore the
        # production message writer so the rating targets the generated reply.
        chat = test_runtime_observation.LocalWebRuntimeTests().web_chat_client()
        chat.client_id, chat.user_id = asset, user
        chat.chat_id = f"existing-{user}-{asset}"
        chat.add_message = ChatClient.add_message.__get__(chat)
        chat.chat_history = [{"category": "existing-session"}]
        with self.session() as db:
            if db.get(MessageSession, chat.chat_id) is None:
                db.add(MessageSession(chat_id=chat.chat_id, user_id=user, tenant_id=TENANT, flow_type=1, flow_id=asset))
                db.commit()

        with freeze_utc(at, runtime, board_observation):
            self.client.portal.call(chat.handle_gpts_message, {"inputs": {"input": "Review this request."}})
        replies = [call.kwargs["message_id"] for call in chat.send_response.await_args_list if call.args[:2] == ("answer", "end")]
        self.assertEqual(len(replies), 1, chat.send_response.await_args_list)
        with self.session() as db:
            receipt = db.exec(select(BoardRuntimeEvent).where(
                BoardRuntimeEvent.kind == "employee", BoardRuntimeEvent.terminal_message_id == replies[0]
            )).one()
            self.assertEqual((receipt.asset_id, receipt.user_id, receipt.department_id, receipt.tenant_id),
                             (asset, user, department, TENANT))
            self.assertEqual((receipt.status, receipt.started_at, receipt.occurred_at), ("success", at, at))
            question = db.get(ChatMessage, receipt.input_message_id)
            answer = db.get(ChatMessage, receipt.terminal_message_id)
            self.assertEqual((question.category, answer.category, answer.message, answer.user_id),
                             ("question", "answer", "ok", user))
            return receipt.run_id, answer.id, chat.chat_id

    def test_T06_shared_employee(self):
        topic = next(row for row in self.overview(11)["ledger"] if row["kind"] == "topic" and row["name"] == "历史合同专题")
        names = ["Scene A", "Scene B"]
        for department, name in enumerate(names, 1):
            self.request("PUT", f"company-boards/planning/{YEAR}", json={
                "kind": "scene", "name": name, "topic_id": topic["id"], "department_id": department,
                "planned_date": "2026-11-01", "completed_date": "2026-11-01", "asset_keys": ["assistant:2"],
            })
        registered = self.overview(11)["ledger"]
        self.assertCountEqual(
            [(row["name"], row["effective_date"]) for row in registered if row["kind"] == "scene" and row["name"] in names],
            [(name, "2026-11-01") for name in names],
        )

        def check(uses, users):
            data = self.overview(11)
            service = data["scene_service"]
            self.assertEqual((service["uses"], service["users"]), (uses, users))
            employee, = service["employees"]
            self.assertEqual((employee["asset_id"], employee["uses"], employee["users"]), ("assistant:2", uses, users))
            self.assertCountEqual([s["name"] for s in employee["scenes"]], names)
            self.assertEqual(data["scene_usage"], [])
            return uses, users

        readings = [check(0, 0)]
        for index, (user, department) in enumerate([(41, 1), (41, 1), (41, 1), (42, 2)], 1):
            self.observed_turn("2", user, department, datetime(YEAR, 11, 2, 4, 0, index))
            readings.append(check(index, 1 if index < 4 else 2))
        print("T06 aggregate (runs, users):", readings, "| attributable scene rows: 0")

    def test_T07_month_end_feedback(self):
        owner = identity(22)
        run_id, message_id, chat_id = self.observed_turn("1", owner.user_id, 1, datetime(YEAR, 10, 31, 15, 55))
        first_negative = datetime(YEAR, 10, 31, 15, 58)  # Oct 31 23:58 Beijing
        resolved = datetime(YEAR, 10, 31, 16, 0)  # Nov 1 00:00 Beijing
        comment, measure = "Cost mismatch", "Corrected evidence"

        def check_rating(negative, rate):
            self.assertEqual(self.overview(10)["satisfaction"],
                             {"successful": 1, "linked": 1, "negative": negative, "positive_rate": rate})

        def issues(month):
            return self.request("GET", "company-boards/monitoring/feedback", params={
                "year": YEAR, "month": month, "run_id": run_id, "stage": "pending",
            })

        def counts(result):
            return result["pending"], result["closed"], result["total"]

        check_rating(0, 1)
        with patch.object(self, "user", owner), freeze_utc(first_negative, web_rating):
            self.request("POST", "liked", json={"message_id": message_id, "liked": 2})
            self.request("POST", "chat/comment", json={"message_id": message_id, "comment": comment})
        check_rating(1, 0)
        self.assertEqual(counts(issues(10)), (1, 0, 1))

        with patch.object(self, "user", owner), freeze_utc(datetime(YEAR, 10, 31, 15, 59), web_rating):
            self.request("POST", "liked", json={"message_id": message_id, "liked": 1})
        check_rating(0, 1)
        pending = issues(10)
        self.assertEqual(counts(pending), (1, 0, 1))
        row, = pending["rows"]
        self.assertEqual(row["comment"], comment)
        self.assertEqual(datetime.fromisoformat(row["opened_at"]), first_negative.replace(tzinfo=UTC))

        with patch.object(feedback, "utc_now", return_value=resolved):
            for text in (measure, "Duplicate attempt"):
                self.request("PUT", f"company-boards/feedback/{run_id}/resolution", json={"measure": text})
        self.assertEqual(counts(issues(10)), (1, 0, 1))
        self.assertEqual(counts(issues(11)), (0, 0, 0))
        annual = self.request("GET", "company-boards/feedback", params={"year": YEAR})
        self.assertEqual(counts(annual), (0, 1, 1))
        closed, = annual["rows"]
        self.assertEqual((closed["run_id"], closed["comment"], closed["measure"]), (run_id, comment, measure))
        self.assertEqual(datetime.fromisoformat(closed["resolved_at"]), resolved)
        with self.session() as db:
            chat = db.get(MessageSession, chat_id)
            self.assertEqual((db.get(ChatMessage, message_id).liked, chat.like, chat.dislike), (1, 1, 0))
        print("T07 satisfaction: 100% -> 0% -> 100% | October pending: 1 | November opened: 0 | yearly closed: 1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
