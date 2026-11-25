"""AIHOT event pages and JSON expose different levels of the timeline."""

import io
import unittest
from email.message import Message
from unittest.mock import patch
from urllib.error import HTTPError

from bs4 import BeautifulSoup

import aihot_page
import feeds
from test_feeds import sample

SID = "68ccf963-6e38-4e86-b2f3-289bd70774fb"
URL = f"https://aihot.news/story/{SID}"
PAGE = f"""
<link rel="canonical" href="{URL}"><main><h1>事件详情</h1>
<section><h2>事件进展</h2><button>最新在前</button><ol><li><div>11月23日 22:04 · 8 篇报道</div>
<a href="/items/ajcxs84uezjqgsgxpdtr31o0l">NVIDIA董事会恢复黄仁勋职务</a>
<div>X.PIN：NVIDIA 宣布黄仁勋复任总裁兼 CEO 并重回董事会</div></li></ol></section>
<section id="event-reports"><h2>报道时间线</h2></section>
<section><h2>相关主题</h2><a href="/other">推荐话题</a></section></main>"""


class AihotTests(unittest.TestCase):
    def test_page_collects_the_verified_progress_group_only(self):
        fragment = aihot_page.extract_progress(PAGE.encode(), URL)
        doc = BeautifulSoup(fragment, "html.parser")
        self.assertEqual(
            doc.select_one("ol li a")["href"],
            "https://aihot.news/items/ajcxs84uezjqgsgxpdtr31o0l",
        )
        self.assertIn("8 篇报道", doc.get_text())
        self.assertNotIn("推荐话题", fragment)
        self.assertNotIn("最新在前", fragment)
        self.assertIsNone(
            aihot_page.extract_progress(PAGE.replace("事件进展", "概览").encode(), URL)
        )
        for bad in (
            PAGE.replace(SID, "other"),
            "<main><h1>加载中</h1></main>",
            PAGE.replace("<ol>", "<div>").replace("</ol>", "</div>"),
        ):
            with self.assertRaises(aihot_page.ProgressUnavailable):
                aihot_page.extract_progress(bad.encode(), URL)

    def test_offsite_urls_and_redirects_are_not_read(self):
        with patch.object(aihot_page, "open_source") as fetch:
            with self.assertRaises(aihot_page.ProgressUnavailable):
                aihot_page.progress_html("https://elsewhere.example/report")
            fetch.assert_not_called()
            headers = Message()
            headers["Location"] = "https://elsewhere.example/story"
            fetch.side_effect = HTTPError(URL, 302, "Moved", headers, io.BytesIO())
            with self.assertRaises(aihot_page.ProgressUnavailable):
                aihot_page.progress_html(SID)
            self.assertEqual(fetch.call_args.args[0].full_url, URL)
            fetch.assert_called_once()

    def test_api_report_html_and_page_group_render_together(self):
        data = sample("aihot")
        detail = data["detail"]["story"]
        detail["digest"] = (
            "<p>事件概览</p><ul><li>进展甲</li></ul><figure><img src='/img/event.jpg' alt='活动现场'></figure>"
        )
        detail["reports"][0]["summary"] = "<p>这是报道摘要。</p><p>后续进展。</p>"
        group = aihot_page.extract_progress(PAGE.encode(), URL)
        with (
            patch.object(feeds, "fetch_json", return_value=data["detail"]),
            patch("aihot_page.progress_html", return_value=group) as fetch,
        ):
            article = feeds.aihot(data["row"])
        fetch.assert_called_once_with(detail["publicId"])
        self.assertEqual(article["native_id"], detail["publicId"])
        self.assertEqual(article["title"], detail["title"])
        self.assertEqual(article["fields"]["page_progress"], group)
        doc = BeautifulSoup(article["html_content"], "html.parser")
        self.assertEqual(doc.img["src"], "https://aihot.news/img/event.jpg")
        self.assertEqual(len(doc.select("ol")), 2)
        self.assertIn(
            detail["reports"][0]["links"]["aihot"],
            {a.get("href") for a in doc.select("ol a")},
        )
        for key in ("markdown_content", "html_content"):
            self.assertIn("这是报道摘要。", article[key])
            self.assertIn("NVIDIA董事会恢复黄仁勋职务", article[key])

    def test_no_digest_delivers_sourced_reports_and_marks_only_failures(self):
        data = sample("aihot")
        detail = data["detail"]["story"]
        detail["digest"] = None
        with patch.object(feeds, "fetch_json", return_value=data["detail"]):
            with patch(
                "aihot_page.progress_html", side_effect=aihot_page.ProgressUnavailable()
            ):
                article = feeds.aihot(data["row"])
                self.assertTrue(article["progress_unavailable"])
                self.assertIn("macOS", article["markdown_content"])
            with patch("aihot_page.progress_html", return_value=None):
                article = feeds.aihot(data["row"])
                self.assertNotIn("progress_unavailable", article)
                self.assertNotIn("page_progress", article["fields"])

    def test_event_page_progress_or_latest_can_supply_the_whole_body(self):
        data = sample("aihot")
        story = data["detail"]["story"]
        story.update(digest=None, latest=None, reports=[])
        progress = aihot_page.extract_progress(PAGE.encode(), URL)
        with patch.object(feeds, "fetch_json", return_value=data["detail"]):
            with patch("aihot_page.progress_html", return_value=progress) as page:
                article = feeds.aihot(data["row"])
                page.assert_called_once_with(story["publicId"])
                self.assertEqual(article["fields"]["page_progress"], progress)
                self.assertIn("NVIDIA董事会恢复黄仁勋职务", article["markdown_content"])
            story["latest"] = "开发团队首次发布了供 macOS 和 Linux 安装的预览版。"
            with patch(
                "aihot_page.progress_html", side_effect=aihot_page.ProgressUnavailable()
            ):
                article = feeds.aihot(data["row"])
                self.assertTrue(article["progress_unavailable"])
                self.assertIn(story["latest"], article["html_content"])

    def test_title_only_discovery_stays_pending_even_with_empty_markup(self):
        data = sample("aihot")
        row = data["row"]
        story = data["detail"]["story"]
        story.update(latest=story["title"] + "。", digest="<p> </p>")
        story["reports"][0]["summary"] = None
        for page_result in (
            None,
            f'<ol><li><a href="/item">{story["title"]}</a></li></ol>',
            aihot_page.ProgressUnavailable("页面读取超时"),
        ):
            with (
                self.subTest(page_result=page_result),
                patch.object(
                    feeds, "fetch_json", side_effect=[{"items": [row]}, data["detail"]]
                ),
                patch("aihot_page.progress_html", side_effect=[page_result]) as page,
            ):
                articles, failures = feeds.collect(feeds.AIHOT["id"], [])
                page.assert_called_once_with(story["publicId"])
                self.assertEqual(articles, [])
                self.assertEqual(failures[0]["item"], row)
