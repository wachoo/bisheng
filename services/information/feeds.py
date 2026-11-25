"""Discovery and article conversion for the two configured public Information sources."""

import gzip
import json
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html import escape
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.parse import quote, unquote_plus, urljoin, urlsplit, urlunsplit
from urllib.request import Request
from uuid import NAMESPACE_URL, uuid5

from richtext import convert_html, only_media_references
from source_http import open_source


def source(name, page, description):
    return {
        "id": str(uuid5(NAMESPACE_URL, page)),
        "source_id": page,
        "name": name,
        "original_url": page,
        "description": description,
        "business_type": "website",
    }


AIHOT = source("AIHOT 热点榜", "https://aihot.news/hot", "AI 行业热点事件")
RADAR = source("能源招标机会雷达", "http://47.120.55.7:8001/", "能源行业公开招标机会")
SOURCES = {s["id"]: s for s in (AIHOT, RADAR)}
FEEDS = {
    AIHOT["id"]: "https://aihot.news/api/v1/hot-topics",
    RADAR["id"]: "http://47.120.55.7:8001/api/opportunities",
}
CHINA = timezone(timedelta(hours=8))
MAX_BYTES = 16 * 1024 * 1024
# Conditional revalidation is a process-local performance hint. Retry records live in the store.
_cache = OrderedDict()
_backoff = {}
_cache_lock = threading.Lock()


def fetch_json(url):
    host = urlsplit(url).netloc
    headers = {
        "User-Agent": "BiSheng-Information/1.0",
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
    }
    with _cache_lock:
        if _backoff.get(host, 0) > time.monotonic():
            raise ValueError("上游要求稍后重试")
        cached = _cache.get(url)
    if cached:
        headers["If-None-Match"] = cached[0]
        if cached[2] > time.monotonic():
            return cached[1]
    try:
        with open_source(Request(url, headers=headers), timeout=25) as response:
            stream = (
                gzip.GzipFile(fileobj=response)
                if response.headers.get("Content-Encoding") == "gzip"
                else response
            )
            raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("上游响应超过大小上限")
            value = json.loads(raw)
            etag = response.headers.get("ETag")
            control = response.headers.get("Cache-Control", "")
    except HTTPError as error:
        with error:
            if error.code in (429, 503):
                retry = error.headers.get("Retry-After", "60")
                try:
                    seconds = (
                        int(retry)
                        if retry.isdigit()
                        else parsedate_to_datetime(retry).timestamp() - time.time()
                    )
                except (ValueError, TypeError, OverflowError):
                    seconds = 60
                with _cache_lock:
                    _backoff[host] = time.monotonic() + max(1, seconds)
            if error.code != 304 or not cached:
                raise
            etag, value, _ = cached
            control = error.headers.get("Cache-Control", "")
    if etag and host == "aihot.news":
        ttl = re.search(r"(?:^|,)\s*s-maxage=(\d+)", control)
        expires = time.monotonic() + (int(ttl[1]) if ttl else 0)
        with _cache_lock:
            _cache[url] = (etag, value, expires)
            _cache.move_to_end(url)
            if len(_cache) > 128:
                _cache.popitem(last=False)
    return value


def text(value):
    return value.strip() if isinstance(value, str) else ""


def native(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return ""
    return str(value).strip()


def link(value):
    value = text(value)
    if not value or re.search(r'[\s\x00-\x1f\x7f\\<>"]', value):
        raise ValueError("缺少有效的 HTTP 原文链接")
    parts = urlsplit(value)
    if (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or parts.username
        or parts.password
    ):
        raise ValueError("原文链接无效")
    # These five UTM parameters describe attribution. Keep business query bytes and hash routes intact.
    tracking = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"}
    query = "&".join(
        param
        for param in parts.query.split("&")
        if unquote_plus(param.partition("=")[0]).lower() not in tracking
    )
    return urlunsplit(
        (parts.scheme, parts.netloc.lower(), parts.path, query, parts.fragment)
    )


def date(value):
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    return (dt if dt.tzinfo else dt.replace(tzinfo=CHINA)).isoformat()


def render(title, url, native_id, published, fields, metadata, blocks):
    """Render one sequence of paragraph, heading or link blocks in both supported formats."""
    if not title:
        raise ValueError("正文缺少标题")
    md, html = [], []
    for kind, value in blocks:
        if not value:
            continue
        if kind == "rich":
            md.append(value[0])
            html.append(value[1])
        elif kind == "url":
            target = link(value)
            md.append("<" + target + ">")
            html.append(
                f'<p><a href="{escape(target, quote=True)}">{escape(target)}</a></p>'
            )
        else:
            # Escape Markdown syntax as well as raw HTML from upstream text.
            clean = re.sub(
                r"([\\`*_{}\[\]()#!|~>])", r"\\\1", escape(value, quote=False)
            )
            md.append(("### " if kind == "heading" else "") + clean)
            tag = "h3" if kind == "heading" else "p"
            html.append(f"<{tag}>" + escape(value).replace("\n", "<br>") + f"</{tag}>")
    return {
        "native_id": native_id or None,
        "title": title,
        "original_url": url,
        "publish_date": date(published),
        "markdown_content": "\n\n".join(md),
        "html_content": "\n".join(html),
        "fields": fields,
        "metadata": metadata,
    }


def structured_body(value, base_url):
    """Convert a target site's HTML fragment when a mixed-format field contains markup."""
    if not value or not re.search(
        r"<(?:p|h[1-6]|table|div|section|article|ul|ol|blockquote|figure|img|a|strong|em|br)\b[^>]*>",
        value,
        re.IGNORECASE,
    ):
        return None
    return convert_html(value, base_url)


def aihot(row):
    import aihot_page

    sid = native(row.get("storyPublicId"))
    if not sid:
        raise ValueError("待解析：列表尚未给出事件标识")
    detail = fetch_json("https://aihot.news/api/v1/stories/" + quote(sid, safe=""))[
        "story"
    ]
    canonical = native(detail.get("publicId"))
    if not canonical:
        raise ValueError("事件详情缺少标识")
    url = link(
        detail.get("links", {}).get("aihot") or row.get("links", {}).get("story")
    )

    def body(value, base):
        value = text(value)
        rich = structured_body(value, base)
        if rich:
            return rich[1], rich[2]
        return "".join(
            f"<p>{escape(p)}</p>" for p in re.split(r"\n\s*\n", value) if p
        ), value

    digest_html, digest = body(detail.get("digest"), url)
    latest_html, latest = body(detail.get("latest"), url)
    reports = []
    for report in detail.get("reports") or []:
        if not text(report.get("title")):
            continue
        links = report.get("links") or {}
        page = link(links["aihot"]) if links.get("aihot") else None
        original = link(links["original"]) if links.get("original") else None
        summary_html, summary = body(report.get("summary"), page or url)
        reports.append(
            {
                "title": text(report["title"]),
                "source": text((report.get("source") or {}).get("name")),
                "time": date(report.get("publishedAt")),
                "url": original or page,
                "page_url": page,
                "summary": summary,
                "summary_html": summary_html,
            }
        )
    reports.sort(
        key=lambda r: (r["time"] or "", r["url"] or "", r["title"]), reverse=True
    )
    sections = [digest_html]
    latest_at = date(detail.get("latestAt"))
    if latest:
        sections.extend(
            [
                "<h3>最近进展</h3>",
                f"<p>{escape(latest_at)}</p>" if latest_at else "",
                latest_html,
            ]
        )
    fields = {
        "digest": digest,
        "latest": latest,
        "latest_at": latest_at,
        "reports": reports,
    }
    page_error = None
    try:
        progress = aihot_page.progress_html(canonical)
    except aihot_page.ProgressUnavailable as exc:
        progress = None
        page_error = exc

    def content_key(value):
        return re.sub(r"[\W_]+", "", value).casefold()

    article_title = text(detail.get("title")) or text(row.get("title"))
    titles = {"", content_key(article_title), content_key(text(row.get("title")))}
    evidence = [digest, latest]
    if progress:
        evidence.extend(convert_html(progress, url)[2].splitlines())
    for report in reports:
        if content_key(report["summary"]) != content_key(report["title"]):
            evidence.append(report["summary"])
    if not any(content_key(value) not in titles for value in evidence):
        if page_error is not None:
            raise ValueError("事件接口仅有标题，事件页暂不可读") from page_error
        raise ValueError("事件尚无可读的概要、进展或报道摘要")

    if progress:
        fields["page_progress"] = progress
        sections.extend(["<h3>事件进展</h3>", progress])
    if reports:
        sections.append("<h3>报道时间线</h3><ol>")
        for report in reports:
            title = escape(report["title"])
            page = report["page_url"] or report["url"]
            if page:
                title = f'<a href="{escape(page, quote=True)}">{title}</a>'
            provenance = " · ".join(filter(None, [report["time"], report["source"]]))
            sections.append(
                f"<li><p>{escape(provenance)}</p><p>{title}</p>{report.pop('summary_html')}"
            )
            if report["url"] != page:
                sections.append(
                    f'<p><a href="{escape(report["url"], quote=True)}">报道原文</a></p>'
                )
            sections.append("</li>")
        sections.append("</ol>")
    metadata = {
        k: row[k]
        for k in ("rank", "sourceCount", "signalCount", "participantCount")
        if k in row
    }
    article = render(
        article_title,
        url,
        canonical,
        detail.get("firstReportAt") or detail.get("latestAt"),
        fields,
        metadata,
        [
            ("rich", convert_html("".join(sections), url)),
            ("heading", "数据来源 · AIHOT"),
            ("url", url),
        ],
    )
    if page_error is not None:
        article["progress_unavailable"] = True
    return article


def capture(content, pattern):
    match = re.search(pattern, content)
    return match[1].strip() if match else None


def radar(row):
    rid = native(row.get("id"))
    if not (text(row.get("content")) or text(row.get("content_html"))) and rid:
        detail = fetch_json(FEEDS[RADAR["id"]] + "/" + quote(rid, safe=""))
        if native(detail.get("id")) != rid:
            raise ValueError("公告详情标识不一致")
        row = dict(row, **detail)
    body = text(row.get("content"))
    url = link(row.get("url"))
    fragment = text(row.get("content_html"))
    # Radar displays its content field verbatim in a pre element.
    # Relative resources in an explicit HTML field belong to the target radar page.
    page_url = RADAR["original_url"]
    rich = convert_html(fragment, page_url) if fragment else None
    if rich and not rich[2]:
        rich = None
    supplement = bool(
        rich and body and only_media_references(rich[1], text(row.get("title")))
    )
    if rich and not supplement:
        body = rich[2]
    if not body:
        raise ValueError("未取得公告原文")
    compact = re.sub(r"\s+", "", body)
    deadline_label = (
        r"(?:(?:投标|响应)文件(?:的)?(?:递交|提交)?|投标|报价)(?:的)?截止(?:日期|时间)"
    )
    # Preserve the date/time boundary before joining PDF line fragments such as "0\n9\n日".
    joined_dates = re.sub(
        r"(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(?=\d{1,2}[:：])", r"\1T", body
    )
    calendar = (
        r"(\d{4}(?:年|-|/)\d{1,2}(?:月|-|/)\d{1,2}日?"
        r"(?:T?\d{1,2}(?:时(?:\d{1,2}分(?:\d{1,2}秒)?)?|[:：]\d{2}(?:[:：]\d{2})?)"
        r"(?:Z|[+-]\d{2}:\d{2})?)?)"
    )
    # The opening time is also the submission deadline only when the notice explicitly joins them.
    conjunction = (
        r"(?:[（(][^（）()。；;]{1,36}[）)])?(?:(?:及|和|与)开标时间)?(?:[：:]|为|是)*"
    )
    deadline = capture(
        re.sub(r"\s+", "", joined_dates),
        deadline_label + conjunction + calendar,
    )
    deadline_display = deadline
    if not deadline:
        deadline = text(row.get("deadline"))
        # Upstream uses local midnight for date-only data. A confirmed midnight above is preserved.
        midnight = re.fullmatch(
            r"(\d{4}-\d{2}-\d{2})[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})?",
            deadline,
        )
        if midnight:
            deadline = midnight[1]
        if deadline:
            note = (
                "雷达记录日期，具体时刻请核对原公告"
                if midnight or re.fullmatch(r"\d{4}-\d{2}-\d{2}", deadline)
                else "雷达记录，请核对原公告"
            )
            deadline_display = f"{deadline}（{note}）"

    def notice_field(key, pattern, content):
        extracted = capture(content, pattern)
        listed = text(row.get(key))
        return (extracted or listed) if rich else (listed or extracted)

    code = notice_field(
        "project_code",
        r"(?:项目|招标|采购)编号[：:]([A-Za-z0-9][A-Za-z0-9._/-]*)",
        compact,
    )
    region = notice_field(
        "region",
        r"(?:项目所在地区|项目地点|建设地点)\s*[：:]\s*([^。；;\n]{2,60})",
        body,
    )
    scope = notice_field(
        "scope",
        r"(?:招标范围|采购范围|采购内容)\s*[：:]\s*([\s\S]+?)(?=\n\s*\d+\.\d+|\n\s*\d+\.\s*\n|$)",
        body,
    )
    qualifications = notice_field(
        "qualifications",
        r"(?:投标人资格要求|供应商资格要求|资格条件)\s*[：:\n]\s*([\s\S]+?)(?=\n\s*\d+\.\s*\n|\n投标文件递交截止时间|$)",
        body,
    )
    assessment = {
        k: row[k]
        for k in ("level", "direction", "reason", "relevance_score", "value_score")
        if row.get(k) is not None
    }
    attachments = [
        link(urljoin(page_url, value))
        for value in (row.get("attachment_urls") or [])
        if text(value)
    ]
    fields = {
        "project_code": code,
        "purchaser": text(row.get("purchaser")) or None,
        "notice_type": text(row.get("notice_type")) or None,
        "region": region,
        "deadline": deadline or None,
        "scope": scope,
        "qualifications": qualifications or None,
        "content": body,
        "attachments": attachments,
        "assessment": assessment,
    }

    def value_or_hint(value, label):
        if value:
            return value
        return "详见下方公告原文" if re.search(label, compact) else "原公告未载明"

    blocks = []
    for label, value, marker in [
        ("项目名称", text(row.get("title")), "名称"),
        ("采购人", fields["purchaser"], "招标人|采购人"),
        ("公告类型", fields["notice_type"], "公告"),
        ("项目编号", code, "编号"),
        ("地区", region, "地区|地点"),
        ("发布日期", text(row.get("published_at")), "发布日期"),
        ("截止时间", deadline_display, deadline_label),
        (
            "采购范围",
            scope.splitlines()[0] if scope else None,
            "范围|采购内容|服务内容",
        ),
        ("资格条件", "详见下方公告原文" if qualifications else None, "资格|资质|条件"),
    ]:
        blocks.append(("p", label + "：" + value_or_hint(value, marker)))
    if origin_name := text(row.get("source")):
        blocks.append(("p", "公告来源：" + origin_name))
    if assessment:
        blocks.append(("heading", "雷达研判"))
        for key, label in (
            ("level", "机会等级"),
            ("direction", "方向"),
            ("relevance_score", "相关性评分"),
            ("value_score", "价值评分"),
        ):
            if key in assessment:
                blocks.append(("p", f"{label}：{assessment[key]}"))
        if reason := text(assessment.get("reason")):
            blocks.extend([("heading", "判断理由"), ("p", reason)])
    entries = row.get("evidence") or []
    evidence = (
        [entry for value in entries if (entry := text(value))]
        if isinstance(entries, list)
        else []
    )
    if evidence:
        fields["evidence"] = evidence
        blocks.append(("heading", "原文证据"))
        quotes = "".join(
            f"<blockquote>{escape(entry)}</blockquote>" for entry in evidence
        )
        blocks.append(("rich", convert_html(quotes, page_url)))
    if attachments:
        blocks.append(("heading", "公开附件"))
        blocks.extend(("url", u) for u in attachments)
    blocks.append(("heading", "公告正文"))
    if rich:
        fields["body_format"] = "source_html"
        blocks.append(("rich", rich))
        if supplement:
            blocks.append(("heading", "雷达提供的公告文字"))
    if not rich or supplement:
        blocks.append(("rich", convert_html(f"<pre>{escape(body)}</pre>", page_url)))
    blocks += [("heading", "原公告"), ("url", url)]
    return render(
        text(row.get("title")), url, rid, row.get("published_at"), fields, {}, blocks
    )


def collect(source_id, pending):
    result = fetch_json(FEEDS[source_id])
    rows = result["items"]
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("上游列表 items 格式无效")
    # The current list supersedes a previously failed discovery, even if it now carries a story ID.
    current = {}
    for row in [*pending, *rows]:
        if source_id == AIHOT["id"]:
            key = native(row.get("id")) or native(row.get("storyPublicId"))
        else:
            key = native(row.get("id")) or text(row.get("url"))
        current[key or json.dumps(row, sort_keys=True)] = row
    articles, failures = {}, []
    for row in current.values():
        try:
            article = aihot(row) if source_id == AIHOT["id"] else radar(row)
            if article.get("progress_unavailable"):
                failures.append(
                    {"item": row, "error": "AIHOT 事件页进展暂不可读，稍后重试"}
                )
            if article["native_id"] is None:
                article["discovery"] = row
            articles[article["native_id"] or article["original_url"]] = article
        except (
            ValueError,
            KeyError,
            TypeError,
            AttributeError,
            OSError,
            HTTPException,
        ) as error:
            failures.append({"item": row, "error": str(error)})
    return list(articles.values()), failures
