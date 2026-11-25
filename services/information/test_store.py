import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid5

from store import Store

SOURCES = {
    key: {
        "id": key,
        "source_id": "https://" + key,
        "business_type": "website",
        "name": key,
    }
    for key in ("one", "two")
}


def article(native_id="a", *, url=None, text="公告正文", date=500, rank=1):
    return {
        "native_id": native_id,
        "original_url": url or f"https://notice.example/{native_id}",
        "title": "设备巡检公告",
        "publish_date": date,
        "markdown_content": text,
        "html_content": f"<p>{text}</p>",
        "fields": {"content": text},
        "metadata": {"rank": rank},
    }


class StoreTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "service.db"
        self.store = Store(self.path, SOURCES)
        now = patch("store.time", return_value=1000)
        self.clock = now.start()
        self.addCleanup(now.stop)

    def status(self):
        return next(source for source in self.store.statuses() if source["id"] == "one")

    def test_temporary_first_party_page_failure_retains_progress_until_retry(self):
        saved = article()
        saved["fields"]["page_progress"] = "<ol><li>事件进展</li></ol>"
        self.store.apply("one", [saved], [])
        partial = dict(article(), progress_unavailable=True)
        failed = [{"item": {"id": "a"}, "error": "事件页暂不可读"}]
        self.assertEqual(self.store.apply("one", [partial], failed)["updated"], 0)
        self.assertEqual(self.store.pending("one"), [{"id": "a"}])
        self.assertEqual(self.store.apply("one", [saved], [])["unchanged"], 1)
        # An accessible page can legitimately no longer contain a progress section.
        self.assertEqual(self.store.apply("one", [article()], [])["updated"], 1)

    def test_per_principal_idempotent_subscriptions_persist(self):
        self.store.subscribe("alice", ["one", "two"], True)
        self.clock.return_value += 3
        self.store.subscribe("alice", ["two"], True)
        self.store.subscribe("bob", ["two"], True)
        self.store.configure("two", enabled=False, interval_seconds=300)
        reopened = Store(self.path, SOURCES)
        self.assertEqual(
            [1000, 1000], [s["subscribed_at"] for s in reopened.subscriptions("alice")]
        )
        reopened.subscribe("alice", ["two"], False)
        self.assertEqual(["one"], [s["id"] for s in reopened.subscriptions("alice")])
        self.assertEqual(["two"], [s["id"] for s in reopened.subscriptions("bob")])
        paused = next(s for s in reopened.statuses() if s["id"] == "two")
        self.assertFalse(paused["enabled"])
        self.assertEqual(paused["interval_seconds"], 300)

    def test_identity_revisions_url_history_and_source_scope(self):
        original = self.store.apply("one", [article()], [])["items"][0]
        self.assertEqual(original["id"], str(uuid5(NAMESPACE_URL, "one/a")))
        other = self.store.apply("two", [article()], [])["items"][0]
        self.assertNotEqual(original["id"], other["id"])
        changed_url = "https://notice.example/new?id=7"
        updated = self.store.apply("one", [article(url=changed_url)], [])
        self.assertEqual(
            (updated["updated"], updated["items"][0]["id"]), (1, original["id"])
        )
        # An old canonical URL can still identify a notice when the upstream omits its ID.
        old = self.store.apply(
            "one", [article(None, url="https://notice.example/a")], []
        )
        self.assertEqual(old["items"][0]["id"], original["id"])
        correction = self.store.apply("one", [article("erratum", url=changed_url)], [])
        self.assertEqual(correction["new"], 1)
        self.assertNotEqual(original["id"], correction["items"][0]["id"])

    def test_native_id_attaches_to_url_only_identity(self):
        url = "https://notice.example/post?id=7"
        first = self.store.apply("one", [article(None, url=url)], [])
        second = self.store.apply("one", [article("known", url=url)], [])
        self.assertEqual(first["items"][0]["id"], second["items"][0]["id"])
        self.assertEqual(second["unchanged"], 1)
        moved = self.store.apply("one", [article("known", url=url + "&edition=2")], [])
        self.assertEqual(moved["items"][0]["id"], first["items"][0]["id"])

    def test_anonymous_item_on_reused_address_is_retained_for_retry(self):
        url = "https://notice.example/daily"
        unidentified = article(None, url=url)
        raw = {"url": url, "title": "每日公告"}
        unidentified["discovery"] = raw
        outcome = self.store.apply(
            "one",
            [unidentified, article("day-1", url=url), article("day-2", url=url)],
            [],
        )
        self.assertEqual(
            (outcome["new"], outcome["failed"], outcome["status"]), (2, 1, "partial")
        )
        self.assertEqual(self.store.pending("one"), [raw])
        self.assertIn("每日公告", outcome["errors"][0])

    def test_frozen_pages_include_each_historical_version_once(self):
        self.store.apply("one", [article(i) for i in "abc"], [])
        first, count, snapshot = self.store.page("one", page_size=1)
        _, _, empty = self.store.page("two")
        self.assertEqual(empty, 0)
        self.assertEqual(count, 3)
        old_rows = self.store.page("one")[0]
        self.store.apply(
            "one",
            [article(i, text="revised") for i in "abc"] + [article("late", date=10)],
            [],
        )
        rest = []
        for page in (2, 3):
            batch, total, upper = self.store.page(
                "one", page=page, page_size=1, max_create_time=snapshot
            )
            self.assertEqual((total, upper), (count, snapshot))
            rest.extend(batch)
        self.assertEqual(first + rest, old_rows)
        latest, total, upper = self.store.page("one", min_create_time=snapshot)
        self.assertEqual(total, 4)
        self.assertGreater(upper, snapshot)
        self.assertEqual(len({row["id"] for row in latest}), 4)
        self.assertTrue(all(row["create_time"] == upper for row in latest))
        self.assertEqual(self.store.page("one", min_create_time=upper)[0], latest)
        bootstrap, total, _ = self.store.page("one", page_size=3, bootstrap=True)
        self.assertEqual((len(bootstrap), total), (3, 3))
        self.assertTrue(all(row["publish_date"] == 500 for row in bootstrap))

    def test_state_on_preview_rank_change_partial_and_retry(self):
        preview = self.store.apply("one", [article()], [], preview=True)
        self.assertEqual(preview["new"], 1)
        self.assertIsNone(self.status()["last_sync_at"])
        self.assertEqual(self.store.recent_runs("one"), [])
        self.assertEqual(self.store.page("one")[1], 0)
        self.store.begin("one")
        committed = self.store.apply("one", [article(), article()], [])
        self.assertEqual(committed["new"], 1)
        self.assertEqual(committed["items"][0]["id"], preview["items"][0]["id"])
        previous_version = self.status()["article_list_updated_at"]
        self.clock.return_value += 60
        ranked = self.store.apply("one", [article(rank=99)], [])
        self.assertEqual(ranked["unchanged"], 1)
        self.assertEqual(self.status()["article_list_updated_at"], previous_version)
        self.assertEqual(self.status()["last_sync_at"], 1060)
        self.clock.return_value += 60
        failure = {"item": {"id": "bad"}, "error": "detail unavailable"}
        partial = self.store.apply("one", [article("b")], [failure])
        self.assertEqual(partial["status"], "partial")
        self.assertEqual(self.status()["last_sync_at"], 1120)
        self.assertEqual(self.store.pending("one"), [failure["item"]])
        self.assertEqual(self.store.page("one")[1], 2)
        self.clock.return_value += 60
        self.store.apply("one", [], [failure])
        self.assertEqual(self.status()["last_sync_at"], 1120)
        self.store.fail("one", "upstream offline")
        self.assertEqual(self.store.pending("one"), [failure["item"]])
        self.assertEqual(
            self.store.recent_runs("one")[0]["errors"], ["upstream offline"]
        )
        self.store.apply("one", [], [], preview=True)
        self.assertEqual(self.store.pending("one"), [failure["item"]])
        self.store.apply("one", [article("bad")], [])
        self.assertEqual(self.store.pending("one"), [])
        self.assertEqual(self.status()["last_sync_at"], 1180)
        self.assertEqual(self.store.page("one")[1], 3)

    def test_atomic_batch_failure_preserves_previous_versions_and_checkpoints(self):
        self.store.apply("one", [article()], [])
        self.clock.return_value += 100
        invalid = article("c")
        del invalid["title"]
        with self.assertRaises(KeyError):
            self.store.apply("one", [article("b"), invalid], [])
        self.assertEqual(self.store.page("one")[1], 1)
        self.assertEqual(self.status()["last_sync_at"], 1000)
        self.assertEqual(len(self.store.recent_runs("one")), 1)


if __name__ == "__main__":
    unittest.main()
