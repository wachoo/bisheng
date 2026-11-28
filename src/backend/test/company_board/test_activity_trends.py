import unittest
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine
from sqlmodel import Session

from bisheng.company_board.domain.models.feedback import BoardRating
from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.repositories.activity_trends import trend_query
from bisheng.company_board.domain.services import activity_trends
from bisheng.company_board.domain.services.activity_trends import report_periods


class ActivityTrendsTest(unittest.TestCase):
    def test_windows_use_beijing_dates_and_historical_cutoff(self):
        now = datetime(2026, 3, 8, 10)
        periods = {key: (start, end) for key, start, end in report_periods(2026, 2, now)}
        self.assertEqual(periods[1], (datetime(2025, 12, 31, 16), datetime(2026, 1, 31, 16)))
        self.assertEqual(periods[0], (periods[1][0], periods[2][1]))
        self.assertEqual(periods[-1], (datetime(2025, 11, 30, 16), datetime(2026, 2, 28, 16)))
        self.assertEqual(report_periods(2026, 3, now)[2][2], now)

    def test_excludes_cross_tenant_rows_and_uses_period_end_for_feedback_and_version_members(self):
        engine = create_engine("sqlite://")
        BoardRuntimeEvent.__table__.create(engine)
        BoardRating.__table__.create(engine)
        start = datetime(2026, 1, 31, 20)
        after = datetime(2026, 2, 12)
        periods = [(1, start, datetime(2026, 2, 3)), (0, start, datetime(2026, 3, 1))]

        def fact(ident, kind, status="success", **kwargs):
            return BoardRuntimeEvent(
                id=ident,
                run_id=kwargs.pop("run_id", "root"),
                user_id=5,
                department_id=kwargs.pop("department_id", 8),
                asset_id="helper",
                tenant_id=kwargs.pop("tenant_id", 1),
                kind=kind,
                status=status,
                occurred_at=kwargs.pop("occurred_at", start),
                **kwargs,
            )

        with Session(engine) as session:
            session.add_all(
                [
                    fact("e1", "employee", terminal_message_id=10, active_seconds=2.0),
                    fact("e2", "employee", "failed", run_id="other", department_id=9, active_seconds=3.0),
                    fact("e3", "employee", "failed", run_id="private", tenant_id=2, active_seconds=700),
                    fact("outsider", "tool", department_id=91),
                    fact("f", "file", output_category="image"),
                    fact("v", "version", output_category="page", occurred_at=after),
                    fact("member", "version_member", member_file_id="f", member_version_id="v", occurred_at=after),
                    fact("model", "model", "metered", input_tokens=15, output_tokens=8),
                    fact("incomplete", "model", "metered", input_tokens=900),
                    BoardRating(tenant_id=1, user_id=5, message_id=10, rated_at=start, rating=2),
                    BoardRating(tenant_id=1, user_id=5, message_id=10, rated_at=after, rating=1),
                ]
            )
            session.commit()
            query, _ = trend_query(1, periods, "sqlite", {8: 7, 9: 7})
            rows = {(r.period, r.kind): r for r in session.exec(query)}
        early, year = rows[1, "employee"], rows[0, "employee"]
        self.assertEqual(early.department_id, 7)
        self.assertIsNone(rows[1, "tool"].department_id)
        self.assertEqual(rows[1, "tool"].successful, 1)
        self.assertEqual(
            (early.successful, early.failed, early.timed, early.active_seconds, early.rounds), (1, 1, 2, 5, 1)
        )
        self.assertEqual((early.linked, early.negative, year.negative), (1, 1, 0))
        self.assertEqual(rows[1, "file"].output_day, "2026-02-01")
        self.assertNotIn((0, "file"), rows)
        self.assertEqual(rows[0, "version"].output_category, "page")
        self.assertEqual(rows[0, "model"].tokens, 23)


class TrendResponseTest(unittest.IsolatedAsyncioTestCase):
    async def test_mysql_decimal_totals_have_numeric_api_types(self):
        counts = dict(successful=3, failed=1, cancelled=0, entered=0, timed=4, linked=3, rounds=4, negative=1)
        row = {key: Decimal(value) for key, value in counts.items()}
        row.update(period=0, kind="employee", asset_id="42", active_seconds=Decimal("2.5"),
                   output_day=None, tokens=None)
        with (
            patch("bisheng.company_board.domain.services.boards.require_access", new_callable=AsyncMock),
            patch.object(activity_trends, "load_catalog", new_callable=AsyncMock, return_value=([], [])),
            patch.object(activity_trends, "grouped_trends", new_callable=AsyncMock, return_value=([row], None)),
        ):
            trends = await activity_trends.read_trends(SimpleNamespace(tenant_id=1), "lead", 2026, 11)
        output = trends["year"]["rows"][0]
        for key, value in counts.items():
            self.assertIs(type(output[key]), int, key)
            self.assertEqual(output[key], value)
        self.assertEqual(output["active_seconds"], 2.5)
        self.assertIsNone(output["tokens"])
