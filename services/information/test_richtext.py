import unittest

from bs4 import BeautifulSoup

from richtext import convert_html

BASE = "https://example.org/tenders/view/123?lang=zh"


class RichTextTest(unittest.TestCase):
    def test_headings_paragraphs_inline_semantics_and_nested_lists(self):
        source = (
            "<h2>采购范围</h2><p>项目<span>编号</span>：<b>G7</b><br>须提供"
            "<a href='../rules?t=2'>资格文件</a>。</p>"
            "<ol start=3><li>现场工作<ul><li><i>设备巡检</i></li></ul></li><li>验收</li></ol>"
        )
        md, html, plain = convert_html(source, BASE)
        self.assertIn("## 采购范围", md)
        self.assertIn("项目编号：**G7**", md)
        self.assertIn("[资格文件](<https://example.org/tenders/rules?t=2>)", md)
        self.assertRegex(md, r"3\. 现场工作\n +[-*] \*设备巡检\*\n4\. 验收")
        self.assertIn("<strong>G7</strong>", html)
        self.assertIn("项目编号：G7\n须提供资格文件。", plain)

    def test_figure_lazy_source_and_safe_text_fallback(self):
        source = """
        <figure><img src="data:image/gif;base64,AAAA" data-src="/images/a b(1).png" alt="">
        <figcaption>图 1. 采购范围</figcaption></figure>
        <img src="https://cdn.example/x.png"><img aria-hidden="true" src="/icon">
        <img src="/pixel" width="1" height="1"><img src="javascript:bad" alt="流程图">
        """
        md, html, plain = convert_html(source, BASE)
        document = BeautifulSoup(html, "html.parser")
        images = document.find_all("img")
        self.assertEqual(len(images), 2)
        self.assertEqual(images[0]["alt"], "图 1. 采购范围")
        self.assertEqual(images[0]["src"], "https://example.org/images/a%20b(1).png")
        self.assertTrue(images[1]["alt"].strip())
        self.assertIn("](<https://example.org/images/a%20b(1).png>)", md)
        self.assertIn("采购范围", plain)
        self.assertIn("流程图", md)
        self.assertIn("<figcaption>", html)

    def test_regular_table_and_headerless_table_keep_cell_meanings(self):
        md, html, plain = convert_html(
            "<table><caption>设备清单</caption><thead><tr><th>物料</th><th>数量</th></tr></thead>"
            "<tr><td>A|B<br>型号甲</td><td><strong>7</strong></td></tr></table>"
            "<table><tr><td>11</td><td>22</td></tr><tr><td>33</td><td>44</td></tr></table>",
            BASE,
        )
        self.assertIn("设备清单", md)
        self.assertIn("| 物料 | 数量 |\n| --- | --- |", md)
        self.assertIn("| A\\|B<br>型号甲 | **7** |", md)
        self.assertIn("|  |  |\n| --- | --- |\n| 11 | 22 |", md)
        self.assertIn("<table>", html)
        self.assertIn("型号甲", plain)

    def test_merged_nested_and_irregular_tables_keep_html_geometry(self):
        for inner in [
            "<tr><th colspan=2>设备</th></tr><tr><td>甲</td><td>乙</td></tr>",
            "<tr><td rowspan=2>甲</td><td>乙</td></tr><tr><td>丙</td></tr>",
            "<tr><td><table><tr><td>甲</td></tr></table></td></tr>",
            "<tr><td>甲</td><td>乙</td></tr><tr><td>丙</td></tr>",
        ]:
            with self.subTest(inner=inner):
                md, html, _ = convert_html(
                    f"<table onclick='bad()'>{inner}</table>", BASE
                )
                self.assertIn("<table>", md)
                self.assertEqual(md, html)
                self.assertNotIn("onclick", md)

    def test_sanitize_active_content_in_both_formats_and_escape_literal_markdown(self):
        source = """
        <div hidden>trap</div><span style="display: none!important">trap</span>
        <script>trap</script><style>trap</style><iframe srcdoc="<b>trap</b>"></iframe>
        <svg><a href="/trap">trap</a></svg><form><input value="trap"></form>
        <p onload="bad">[欺骗](javascript:bad) &lt;script&gt; &amp; 实际内容</p>
        <a href="jAvAsCrIpT:bad()" onclick="bad()">可见说明</a><img src="data:image/svg+xml;bad">
        <a href="https://user:secret@example.org/x">拒绝凭据链接</a>
        """
        md, html, plain = convert_html(source, BASE)
        for out in (md, html, plain):
            self.assertNotIn("trap", out)
            self.assertNotIn("secret", out)
            self.assertIn("可见说明", out)
        document = BeautifulSoup(html, "html.parser")
        self.assertFalse(
            document.find_all(["iframe", "script", "svg", "img", "a", "style"])
        )
        self.assertNotIn("onload", html)
        self.assertIn(r"\[欺骗\]", md)
        self.assertIn("&lt;script&gt;", md)


if __name__ == "__main__":
    unittest.main()
