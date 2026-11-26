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

    def test_editing_a_legacy_release_reassigns_future_usage_only(self):
        start = date(2026, 1, 1)
        transition = date(2026, 1, 2)
        entries = [
            SimpleNamespace(kind="scene", id=s, name=s, parent_id="t", effective_date=start, department_id=7)
            for s in ("old", "new")
        ]
        entries.append(SimpleNamespace(kind="release", asset_key="assistant:42", parent_id="old", effective_date=start))
        links = [{"date": transition, "parent_id": "new", "fields": {"asset": "assistant:42"}}]
        events = [(day, "42", "success", count, count, 10, count, 0) for day, count in [(start, 1), (transition, 3)]]
        rows = reconcile_scenes(entries, links, events, start, start, start, transition, {"assistant:42": transition})
        self.assertEqual(
            {r["id"]: (r["year"], r["asset_ids"]) for r in rows}, {"old": (1, []), "new": (3, ["assistant:42"])}
        )
