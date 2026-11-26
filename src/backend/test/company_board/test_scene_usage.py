from datetime import date, datetime
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlmodel import Session

from bisheng.company_board.domain.models.runtime_event import BoardRuntimeEvent
from bisheng.company_board.domain.repositories.scene_usage import employee_service_query
from bisheng.company_board.domain.services.scene_usage import annual_service, reconcile_scenes, scene_relationships


class SceneUsageTest(TestCase):
    def test_case_links_contribute_employees_without_attributing_past_runs(self):
        start = date(2026, 1, 1)
        cutoff = date(2026, 1, 20)
        entries = [
            SimpleNamespace(kind="scene", year=2026, name=s, id=s, effective_date=start, parent_id="t", department_id=7)
            for s in ("case", "cleared", "old")
        ]

        def link(scene, key, day, end=None):
            return {
                "kind": "scene-asset",
                "source": "case",
                "parent_id": scene,
                "date": day,
                "fields": {"asset": key, "end": end},
            }

        links = [
            link("case", "assistant:x", cutoff),
            link("case", "assistant:x", start),
            link("case", "assistant:y", date(2026, 2, 1)),
            link("case", "assistant:z", start, "2026-01-19"),
            link("cleared", "assistant:cleared", start),
            {"kind": "scene-asset", "parent_id": "old", "date": start, "fields": {"asset": "assistant:x"}},
        ]
        mappings, assets = scene_relationships(entries, links, {}, {"cleared": []}, cutoff)
        self.assertEqual(dict(assets), {"case": {"assistant:x"}, "old": {"assistant:x"}})
        rows = reconcile_scenes(
            entries, mappings, assets, [(cutoff, "x", "success", 3, 3, 60, 3, 0)], start, start, start, cutoff
        )
        self.assertEqual([(r["id"], r["year"]) for r in rows], [("old", 3)])

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
        cutoff = date(2026, 5, 31)
        mappings, assets = scene_relationships(entries, reuse, {}, {}, cutoff)
        (result,) = reconcile_scenes(
            entries, mappings, assets, events, date(2026, 1, 1), date(2026, 5, 1), date(2026, 3, 3), cutoff
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
        mappings, assets = scene_relationships(entries, links, {"assistant:42": transition}, {}, transition)
        rows = reconcile_scenes(entries, mappings, assets, events, start, start, start, transition)
        self.assertEqual(
            {r["id"]: (r["year"], r["asset_ids"]) for r in rows}, {"old": (1, []), "new": (3, ["assistant:42"])}
        )


class AnnualSceneServiceTest(IsolatedAsyncioTestCase):
    async def test_counts_service_by_employee_and_distinct_users_across_scenes(self):
        year, cutoff = date(2026, 1, 1), date(2026, 11, 30)
        entries = [SimpleNamespace(kind="scene", id=s, name=s, year=2026, effective_date=None) for s in ("A", "B", "C")]
        entries.append(
            SimpleNamespace(
                kind="release", name="Previous", asset_key="assistant:old", parent_id="C", effective_date=year
            )
        )
        managed = {"A": ["assistant:x", "flow:x", "knowledge:9"], "B": ["assistant:x", "assistant:y"], "C": []}
        _, assets = scene_relationships(entries, [], {}, managed, cutoff)
        engine = create_engine("sqlite://")
        BoardRuntimeEvent.__table__.create(engine)
        edge = datetime(2025, 12, 31, 16)
        end = datetime(2026, 12, 1)

        def run(ident, asset, user, status="success", at=edge, tenant=1, kind="employee"):
            return BoardRuntimeEvent(
                id=ident,
                run_id=ident,
                asset_id=asset,
                user_id=user,
                tenant_id=tenant,
                kind=kind,
                status=status,
                occurred_at=at,
            )

        with Session(engine) as db:
            db.add_all(
                [
                    run("r1", "x", 7),
                    run("r2", "x", 7),
                    run("r3", "y", 7),
                    run("r4", "y", 8),
                    run("failed", "y", 9, "failed"),
                    run("stopped", "y", 9, "cancelled"),
                    run("foreign", "y", 10, tenant=2),
                    run("tool", "x", 11, kind="tool"),
                    run("unlinked", "old", 12),
                    run("before", "x", 13, at=datetime(2025, 12, 31, 15, 59)),
                    run("after", "x", 14, at=datetime(2026, 11, 30, 16)),
                ]
            )
            db.commit()

            async def counts(tenant, start, stop, ids):
                return db.exec(employee_service_query(tenant, start, stop, ids)).all()

            with patch("bisheng.company_board.domain.services.scene_usage.employee_service_counts", counts):
                result = await annual_service(1, year, end, entries, assets, [])
        self.assertEqual((result["uses"], result["users"]), (4, 2))
        employees = {e["asset_id"]: e for e in result["employees"]}
        self.assertEqual(set(employees), {"assistant:x", "assistant:y", "flow:x"})
        self.assertEqual([s["name"] for s in employees["assistant:x"]["scenes"]], ["A", "B"])
        self.assertEqual((employees["assistant:x"]["uses"], employees["assistant:x"]["users"]), (2, 1))
        self.assertEqual((employees["assistant:y"]["uses"], employees["assistant:y"]["users"]), (2, 2))
        self.assertTrue(employees["assistant:x"]["monitored"])
        self.assertFalse(employees["flow:x"]["monitored"])
