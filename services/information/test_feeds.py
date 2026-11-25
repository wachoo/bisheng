"""Adapter regression tests using source excerpts captured on 2026-11-24."""

import json
import unittest
from pathlib import Path
from unittest.mock import patch

import feeds


def sample(name):
    return json.loads(
        (Path(__file__).parent / "samples" / f"{name}.json").read_text(encoding="utf-8")
    )


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("aihot_page.progress_html", return_value=None))

    def test_real_event_includes_recent_report_and_rank_is_metadata_only(self):
        data = sample("aihot")
        row = data["row"]
        with patch.object(feeds, "fetch_json", return_value=data["detail"]):
            article = feeds.aihot(row)
            changed_rank = feeds.aihot(dict(row, rank=1))
        self.assertEqual(article["native_id"], row["storyPublicId"])
        self.assertNotEqual(article.pop("metadata"), changed_rank.pop("metadata"))
        self.assertEqual(article, changed_rank)
        for field in ("markdown_content", "html_content"):
            for fact in (
                "首个",
                "Alpha",
                "Simon Willison",
                "https://simonwillison.net/2026/Nov/23/ladybird/",
                "2026-11-23",
            ):
                self.assertIn(fact, article[field])

    def test_actual_notice_with_unstructured_split_deadline(self):
        row = sample("radar")
        article = feeds.radar(row)
        self.assertEqual(article["fields"]["deadline"], "2026年12月09日09时00分00秒")
        self.assertEqual(article["fields"]["project_code"], "CG0000022002373505")
        self.assertEqual(article["publish_date"], "2026-11-18T11:08:00+08:00")
        for field in ("markdown_content", "html_content"):
            for fact in (
                "中国南方电网有限责任公司",
                "平台样本服务建设",
                "不接受自然人参与",
                "雷达研判",
                row["url"],
            ):
                self.assertIn(fact, article[field])

    def test_notice_revision_uses_new_deadline_in_summary_and_body(self):
        row = dict(sample("radar"), content="投标截止时间：2026年12月10日17时。")
        article = feeds.radar(
            dict(row, content_html="<p>投标截止时间：2026年12月17日17时。</p>")
        )
        self.assertEqual(article["fields"]["deadline"], "2026年12月17日17时")
        self.assertNotIn("12月10日", article["markdown_content"])

    def test_scan_or_attachment_keeps_radar_transcript_and_facts(self):
        row = dict(
            sample("radar"),
            content="投标截止时间：2026年12月17日17时。\n采购范围：巡视机器人。",
        )
        for fragment in (
            '<figure><img src="scan.png"><figcaption>公告扫描件</figcaption></figure>',
            '<p>附件：<a href="notice.pdf">原公告 PDF</a></p>',
            '<p>公告扫描件</p><img src="scan.png">',
            f'<h2>{row["title"]}</h2><p>正文详见附件。</p><a href="notice.pdf">下载附件</a>',
        ):
            article = feeds.radar(dict(row, content_html=fragment))
            self.assertEqual(article["fields"]["deadline"], "2026年12月17日17时")
            for key in ("html_content", "markdown_content"):
                self.assertIn("雷达提供的公告文字", article[key])
                self.assertIn("巡视机器人", article[key])
                self.assertTrue(
                    "scan.png" in article[key] or "notice.pdf" in article[key]
                )

    def test_notice_deadlines_keep_hour_and_timezone(self):
        for value, expected in [
            ("2026年12月10日17时", "2026年12月10日17时"),
            ("2026-12-10 17:00", "2026-12-10T17:00"),
            ("2026-12-10T17:00:00+08:00", "2026-12-10T17:00:00+08:00"),
        ]:
            with self.subTest(value=value):
                row = dict(sample("radar"), content=f"投标截止时间：{value}。")
                self.assertEqual(feeds.radar(row)["fields"]["deadline"], expected)

    def test_bid_submission_deadline_overrides_radar_midnight_and_ignores_document_sale(
        self,
    ):
        # Original notice, section 1.6.1, radar opportunity 4372.
        row = dict(
            sample("radar"),
            deadline="2026-12-15T00:00:00",
            content=(
                "招标文件获取截止时间：2026-11-30 16:00:00。\n"
                "1.6.1 投标文件递交的截止时间（投标截止时间，下同）及开标时间为"
                "2026-12-15 09:00:00（北京时间），投标人应在投标截止时间前通过"
                "“国能e招投标人业务系统”递交电子投标文件。"
            ),
        )
        article = feeds.radar(row)
        self.assertEqual(article["fields"]["deadline"], "2026-12-15T09:00:00")
        for field in ("markdown_content", "html_content"):
            self.assertIn("截止时间：2026-12-15T09:00:00", article[field])
            self.assertNotIn("2026-12-15T00:00:00", article[field])

    def test_unconfirmed_midnight_and_opening_time_alone(self):
        row = dict(
            sample("radar"),
            content="开标时间为2026-12-15 09:00:00。招标文件发售截止时间：2026年11月30日。",
            deadline="2026-12-15T00:00:00",
        )
        article = feeds.radar(row)
        self.assertEqual(article["fields"]["deadline"], "2026-12-15")
        self.assertIn("具体时刻请核对原公告", article["markdown_content"])
        row["content"] = "投标截止时间：2026-12-15 00:00:00。"
        self.assertEqual(feeds.radar(row)["fields"]["deadline"], "2026-12-15T00:00:00")

    def test_url_identity_and_untrusted_text(self):
        row = dict(
            sample("radar"),
            id=None,
            content="采购范围：<b>控制器</b> [链接](data:...)",
            url="https://example.org/notices?key=%2B&key=1&utm_source=list#/routes/2",
        )
        article = feeds.radar(row)
        self.assertEqual(
            article["original_url"],
            "https://example.org/notices?key=%2B&key=1#/routes/2",
        )
        self.assertIsNone(article["native_id"])
        self.assertIn("截止时间：原公告未载明", article["markdown_content"])
        self.assertNotIn("<b>", article["html_content"])
        self.assertIn(
            "<pre>采购范围：&lt;b&gt;控制器&lt;/b&gt;", article["html_content"]
        )
        self.assertIn("```\n" + row["content"] + "\n```", article["markdown_content"])
        with self.assertRaises(ValueError):
            feeds.radar(dict(row, url="data:text/html,foo"))

    def test_detail_retry_after_item_rolls_off_list(self):
        data = sample("aihot")
        row = data["row"]
        with patch.object(
            feeds,
            "fetch_json",
            side_effect=[{"items": [row]}, TimeoutError("详情超时")],
        ):
            articles, failures = feeds.collect(feeds.AIHOT["id"], [])
        self.assertEqual(articles, [])
        self.assertEqual(failures, [{"item": row, "error": "详情超时"}])
        with patch.object(
            feeds, "fetch_json", side_effect=[{"items": []}, data["detail"]]
        ):
            articles, failures = feeds.collect(feeds.AIHOT["id"], [row])
        self.assertEqual(articles[0]["native_id"], row["storyPublicId"])
        self.assertEqual(failures, [])

    def test_missing_identity_resolved_from_new_discovery(self):
        data = sample("aihot")
        row = dict(data["row"], storyPublicId=None)
        with patch.object(feeds, "fetch_json", return_value={"items": [row]}) as fetch:
            articles, failures = feeds.collect(feeds.AIHOT["id"], [])
            fetch.assert_called_once()
        self.assertEqual(articles, [])
        with patch.object(
            feeds, "fetch_json", side_effect=[{"items": [data["row"]]}, data["detail"]]
        ):
            articles, failures = feeds.collect(feeds.AIHOT["id"], [failures[0]["item"]])
        self.assertEqual(len(articles), 1)
        self.assertEqual(failures, [])

    def test_blank_radar_detail_is_not_a_notice(self):
        row = dict(sample("radar"), content="")
        with patch.object(feeds, "fetch_json", side_effect=[{"items": [row]}, row]):
            articles, failures = feeds.collect(feeds.RADAR["id"], [])
        self.assertFalse(articles)
        self.assertIn("未取得公告原文", failures[0]["error"])
        with patch.object(
            feeds, "fetch_json", side_effect=[{"items": []}, sample("radar")]
        ):
            articles, failures = feeds.collect(feeds.RADAR["id"], [row])
        self.assertEqual(articles[0]["native_id"], "4166")
        self.assertEqual(failures, [])

    def test_list_failure_propagates(self):
        with (
            patch.object(feeds, "fetch_json", side_effect=TimeoutError()),
            self.assertRaises(TimeoutError),
        ):
            feeds.collect(feeds.RADAR["id"], [])
