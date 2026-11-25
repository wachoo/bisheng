import secrets
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import patch

from fastapi.testclient import TestClient

import feeds
from app import SOURCES, create_app
from scheduler import Scheduler
from store import Store


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "article.db", SOURCES)
        self.sid = next(iter(SOURCES))
        self.article = {
            "native_id": "a",
            "original_url": "https://example.org/a",
            "title": "采购",
            "publish_date": 100,
            "markdown_content": "巡检",
            "html_content": "<p>巡检</p>",
            "fields": {},
            "metadata": {},
        }
        key, other, admin = (secrets.token_hex(20) for _ in range(3))
        self.api = {"X-API-Key": key}
        self.other = {"X-API-Key": other}
        self.auth = ("admin", admin)
        self.headers = {"X-Admin-Request": "1"}
        app = create_app(
            self.store,
            {"first": key, "second": other},
            admin,
            collector=lambda *_: ([self.article], []),
            schedule=False,
        )
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_catalogue_key_scope_bootstrap_and_delta(self):
        def get(path, **params):
            return self.client.get(
                "/information/" + path, params=params, headers=self.api
            ).json()

        self.assertEqual(get("list", business_type="website")["totalCount"], 2)
        self.assertEqual(get("search", keyword="能源")["totalCount"], 1)
        self.assertEqual(get("list", business_type="wechat")["data"], [])
        payload = {"information_ids": [self.sid]}
        for endpoint in ("source_by_ids", "subscribe", "subscribe"):
            self.assertEqual(
                self.client.post(
                    "/information/" + endpoint, json=payload, headers=self.api
                ).json()["code"],
                200,
            )
        self.assertEqual(get("subscriptions")["totalCount"], 1)
        self.assertEqual(
            self.client.get("/information/subscriptions", headers=self.other).json()[
                "totalCount"
            ],
            0,
        )
        self.store.begin(self.sid)
        self.store.apply(self.sid, [self.article], [])
        path = f"articles/{self.sid}"
        first = get(path + "/bootstrap")
        self.assertEqual(first["totalCount"], len(first["data"]["articles"]))
        cursor = first["data"]["snapshot_max_create_time"]
        old = first["data"]["articles"][0]
        self.store.begin(self.sid)
        self.store.apply(self.sid, [dict(self.article, title="更正")], [])
        frozen = get(
            path,
            min_create_time=cursor,
            max_create_time=cursor,
            return_information="true",
        )
        self.assertEqual(frozen["data"]["articles"], [old])
        self.assertEqual(frozen["data"]["information"]["id"], self.sid)
        current = get(path, min_create_time=cursor)["data"]["articles"][0]
        self.assertEqual((current["id"], current["title"]), (old["id"], "更正"))
        self.client.post("/information/unsubscribe", json=payload, headers=self.api)
        self.assertEqual(get("subscriptions")["totalCount"], 0)

    def test_admin_auth_config_preview_and_no_publishing(self):
        url = "/admin/api/sources/" + self.sid
        self.assertEqual(self.client.get(url, headers=self.api).status_code, 401)
        self.assertEqual(
            self.client.get("/information/list", auth=self.auth).json()["code"], 401
        )
        self.assertEqual(
            self.client.patch(url, auth=self.auth, json={"enabled": False}).status_code,
            403,
        )

        def patch(**values):
            return self.client.patch(
                url, auth=self.auth, headers=self.headers, json=values
            )

        self.assertEqual(patch(interval_seconds=59).status_code, 422)
        self.assertEqual(
            patch(enabled=False, interval_seconds=900).json()["enabled"], False
        )
        preview = self.client.post(
            url + "/preview", auth=self.auth, headers=self.headers
        )
        self.assertEqual(preview.json()["items"][0]["status"], "new")
        after = self.client.get(url, auth=self.auth).json()
        self.assertEqual(after["runs"], [])
        self.assertIsNone(after["last_sync_at"])
        self.assertEqual(self.store.page(self.sid)[1], 0)
        self.assertEqual(patch(enabled=True).json()["interval_seconds"], 900)
        self.assertEqual(
            self.client.get("/admin/sources/" + self.sid, auth=self.auth).status_code,
            200,
        )

    def test_pause_discards_inflight_collection(self):
        started, finish = Event(), Event()

        def delayed(*_):
            started.set()
            finish.wait(3)
            return [self.article], []

        runner = Scheduler(self.store, [self.sid], delayed)
        runner.start()
        try:
            self.assertTrue(started.wait(3))
            runner.configure(self.sid, enabled=False)
            finish.set()
        finally:
            finish.set()
            runner.stop()
        self.assertIsNone(runner.status(self.sid)["last_sync_at"])
        self.assertEqual(self.store.page(self.sid)[1], 0)

    def test_radar_publishes_only_target_structure_and_retries_old_discoveries(self):
        sid = feeds.RADAR["id"]
        row = {
            "id": 42,
            "title": "采购公告",
            "content": "采购范围：设备",
            "url": "https://www.bidding.csg.cn/zbgg/1200450491.jhtml",
            "evidence": ["标包 A", "886.16 万元"],
        }
        fragment = (
            "<h3>报价</h3><table><tr><th>标包</th><th>万元</th></tr>"
            "<tr><td>A</td><td>886.16</td></tr></table>"
            '<figure><img src="/plan.png" alt="施工范围图"><figcaption>厂区平面图</figcaption></figure>'
        )

        def run(item):
            with patch.object(
                feeds, "fetch_json", return_value={"items": [item]}
            ) as fetch:
                result = self.store.apply(
                    sid, *feeds.collect(sid, self.store.pending(sid))
                )
                fetch.assert_called_once_with(feeds.FEEDS[sid])
                return result

        rich_row = dict(row, content_html=fragment)
        saved = run(rich_row)
        self.assertEqual(saved["new"], 1)
        result = self.client.get(
            "/information/articles/" + sid, headers=self.api
        ).json()
        article = result["data"]["articles"][0]
        self.assertEqual(article["id"], saved["items"][0]["id"])
        self.assertIn("| A | 886.16 |", article["markdown_content"])
        self.assertIn("施工范围图", article["markdown_content"])
        self.assertIn('src="http://47.120.55.7:8001/plan.png"', article["html_content"])
        self.assertIn("<td>886.16</td>", article["html_content"])
        self.store.apply(sid, [], [{"item": row, "error": "原公告暂不可读"}])
        refreshed = run(row)
        self.assertEqual((refreshed["updated"], refreshed["failed"]), (1, 0))
        current = refreshed["items"][0]
        self.assertEqual(article["id"], current["id"])
        self.assertNotIn("<table", current["html_content"])
        self.assertIn("<pre>采购范围：设备</pre>", current["html_content"])
        self.assertIn("<blockquote>886.16 万元</blockquote>", current["html_content"])
        self.assertEqual(self.store.pending(sid), [])
        self.assertEqual(run(row)["unchanged"], 1)

    def test_ambiguous_discovery_does_not_discard_other_notices(self):
        sid = feeds.RADAR["id"]
        base = {
            "title": "采购公告",
            "content": "采购范围：巡检",
            "url": "https://example.org/notices",
        }
        unknown = dict(base, title="公告待识别")
        for rows in (
            [dict(base, id=1), dict(base, id=2)],
            [unknown, dict(base, id=3, url="https://example.org/three")],
        ):
            with patch.object(feeds, "fetch_json", return_value={"items": rows}):
                candidates, failed = feeds.collect(sid, self.store.pending(sid))
            result = self.store.apply(sid, candidates, failed)
        self.assertEqual((result["new"], result["failed"]), (1, 1))
        self.assertEqual(self.store.pending(sid), [unknown])
        self.assertEqual(self.store.page(sid)[1], 3)
