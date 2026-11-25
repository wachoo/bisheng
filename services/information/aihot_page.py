"""Optional progress groups from AIHOT's own event page (the public JSON lists individual reports)."""

import re
from collections import OrderedDict
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from threading import Lock
from time import monotonic, time
from urllib.error import HTTPError
from urllib.request import Request

from bs4 import BeautifulSoup

from richtext import sanitize
from source_http import open_source


class ProgressUnavailable(OSError):
    """The page could not be identified or read; absence of progress is unknown."""


_cache = OrderedDict()
_lock = Lock()
_retry_at = 0.0
_MAX_BYTES = 2 * 1024 * 1024


def extract_progress(body, url):
    doc = BeautifulSoup(body, "html.parser", from_encoding="utf-8")
    canonical = doc.select_one("link[rel~=canonical][href]")
    if not canonical or canonical["href"] != url or not doc.select_one("main h1"):
        raise ProgressUnavailable("AIHOT 返回的页面无法确认为该事件")
    for heading in doc.select("main section h2"):
        if heading.get_text(strip=True) != "事件进展":
            continue
        listing = heading.find_parent("section").find(["ol", "ul"])
        if not listing or not listing.select("li a[href]"):
            raise ProgressUnavailable("事件进展分组格式已变化")
        # Exclude sorting controls, badges outside the list, related stories and the site shell.
        return sanitize(str(listing), url).decode_contents()
    if not doc.select_one("main #event-reports"):
        raise ProgressUnavailable("未识别 AIHOT 事件正文")
    return None


def progress_html(story_id):
    global _retry_at
    if not re.fullmatch(
        r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", story_id
    ):
        raise ProgressUnavailable("无效的 AIHOT 事件页标识")
    url = "https://aihot.news/story/" + story_id
    with _lock:
        now = monotonic()
        cached = _cache.get(url)
        if cached and cached[0] > now:
            _cache.move_to_end(url)
            return cached[1]
        if _retry_at > now:
            raise ProgressUnavailable("AIHOT 要求稍后读取事件页")
        headers = {"Accept": "text/html", "User-Agent": "BiSheng-Information/1.0"}
        if cached and cached[2]:
            headers["If-None-Match"] = cached[2]
        try:
            with open_source(Request(url, headers=headers), timeout=6) as response:
                if response.headers.get_content_type() != "text/html":
                    raise ProgressUnavailable("AIHOT 事件页未返回 HTML")
                data = response.read(_MAX_BYTES + 1)
                if len(data) > _MAX_BYTES:
                    raise ProgressUnavailable("AIHOT 事件页超过读取上限")
                fragment = extract_progress(data, url)
                etag = response.headers.get("ETag")
                control = response.headers.get("Cache-Control", "")
        except HTTPError as exc:
            with exc:
                if exc.code in (429, 503):
                    retry = exc.headers.get("Retry-After", "60")
                    try:
                        wait = (
                            float(int(retry))
                            if retry.isdecimal()
                            else parsedate_to_datetime(retry).timestamp() - time()
                        )
                    except (ValueError, OverflowError, TypeError):
                        wait = 60
                    _retry_at = monotonic() + max(1, wait)
                if exc.code != 304 or not cached:
                    raise ProgressUnavailable(
                        f"AIHOT 事件页返回 HTTP {exc.code}"
                    ) from exc
                _, fragment, etag = cached
                control = exc.headers.get("Cache-Control", "")
        except (OSError, HTTPException, ValueError, RecursionError) as exc:
            raise ProgressUnavailable("AIHOT 事件页暂不可读") from exc
        ttl = re.search(r"(?:^|,)\s*s-maxage=(\d+)", control)
        _cache[url] = (
            monotonic() + max(60, int(ttl[1]) if ttl else 300),
            fragment,
            etag,
        )
        _cache.move_to_end(url)
        if len(_cache) > 64:
            _cache.popitem(last=False)
        return fragment
