from datetime import date
from types import SimpleNamespace
from unittest import TestCase

from bisheng.company_board.domain.services.scene_usage import reconcile_scenes


class SceneUsageTest(TestCase):
    def test_shared_employee_windows_and_prior_year_scene(self):
        begin = date(2025, 4, 1)
        entries = [SimpleNamespace(kind="topic", id="t", name="项目")]
        for id in ("a", "b"):
            entries.append(
                SimpleNamespace(kind="scene", id=id, name=id, effective_date=begin, department_id=7, parent_id="t")
            )
        entries.append(SimpleNamespace(kind="release", asset_key="assistant:5", parent_id="a", effective_date=begin))
        reuse = [{"date": date(2026, 5, 5), "parent_id": "b", "fields": {"asset": "assistant:5", "end": "2026-05-11"}}]
        # day, assistant, result, events, timed, seconds, linked messages, negative ratings
        events = [
            (day, "5", status, count, count, count * 60, linked, negative)
            for day, status, count, linked, negative in [
                ("2026-01-02", "success", 4, 4, 0),
                ("2026-04-01", "success", 2, 2, 1),
                ("2026-05-07", "success", 10, 10, 2),
                ("2026-05-15", "success", 3, 3, 0),
                ("2026-05-18", "failed", 1, 0, 0),
            ]
        ]
        (result,) = reconcile_scenes(
            entries, reuse, events, date(2026, 1, 1), date(2026, 5, 1), date(2026, 3, 3), date(2026, 5, 31)
        )
        self.assertEqual((result["id"], result["year"], result["month"], result["last90"]), ("a", 9, 3, 5))
        self.assertEqual(result["asset_ids"], ["assistant:5"])
        self.assertEqual(result["last_used"], date(2026, 5, 15))
        self.assertEqual(result["month_hours"], 4 / 60)
        self.assertEqual(result["positive_rate"], 0.8)
        self.assertEqual(result["month_positive_rate"], 1)
