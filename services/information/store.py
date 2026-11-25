"""Persistent source configuration, collection state and versioned article snapshots."""

import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import time
from uuid import NAMESPACE_URL, uuid5

SCHEMA = """
CREATE TABLE IF NOT EXISTS source (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    interval_seconds INTEGER NOT NULL DEFAULT 1800,
    last_attempt_at INTEGER,
    last_sync_at INTEGER,
    article_list_updated_at INTEGER,
    active_since INTEGER
);
CREATE TABLE IF NOT EXISTS subscription (
    principal TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES source(id),
    subscribed_at INTEGER NOT NULL,
    PRIMARY KEY (principal, source_id)
);
CREATE TABLE IF NOT EXISTS article (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES source(id),
    native_id TEXT,
    discovered_at INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    UNIQUE (source_id, native_id)
);
CREATE TABLE IF NOT EXISTS article_url (
    url TEXT NOT NULL,
    article_id TEXT NOT NULL REFERENCES article(id),
    PRIMARY KEY (url, article_id)
);
CREATE TABLE IF NOT EXISTS version (
    article_id TEXT NOT NULL REFERENCES article(id),
    revision INTEGER NOT NULL,
    publish_time INTEGER,
    digest TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (article_id, revision)
);
CREATE TABLE IF NOT EXISTS pending_item (
    source_id TEXT NOT NULL REFERENCES source(id),
    item TEXT NOT NULL,
    PRIMARY KEY (source_id, item)
);
CREATE TABLE IF NOT EXISTS collection_run (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES source(id),
    summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_by_source ON collection_run (source_id, id);
"""

PUBLIC_SOURCE_KEYS = (
    "id",
    "source_id",
    "business_type",
    "name",
    "description",
    "original_url",
    "icon",
    "follow_num",
)
ARTICLE_KEYS = (
    "title",
    "original_url",
    "markdown_content",
    "html_content",
    "publish_date",
)


def encode(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def publish_timestamp(value):
    if value is None or isinstance(value, int):
        return value
    if value.isdigit():
        return int(value)
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone(timedelta(hours=8)))
    return int(parsed.timestamp())


class AmbiguousArticleURL(ValueError):
    """A URL-only discovery cannot be assigned to one of several known issues."""


class Store:
    def __init__(self, path, sources):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.sources = {
            source_id: {key: source[key] for key in PUBLIC_SOURCE_KEYS if key in source}
            for source_id, source in sources.items()
        }
        with closing(self.connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            db.executemany(
                "INSERT OR IGNORE INTO source (id) VALUES (?)",
                [(key,) for key in sources],
            )

    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def statuses(self):
        with closing(self.connect()) as db:
            rows = db.execute("""
                SELECT s.id, s.enabled, s.interval_seconds, s.last_attempt_at, s.last_sync_at,
                       s.article_list_updated_at, (
                           SELECT summary FROM collection_run
                           WHERE source_id = s.id ORDER BY id DESC LIMIT 1
                       ) AS last_result
                FROM source s ORDER BY s.id
            """)
            return [
                dict(
                    self.sources[row["id"]],
                    enabled=bool(row["enabled"]),
                    interval_seconds=row["interval_seconds"],
                    last_attempt_at=row["last_attempt_at"],
                    last_sync_at=row["last_sync_at"],
                    article_list_updated_at=row["article_list_updated_at"],
                    last_result=json.loads(row["last_result"])
                    if row["last_result"]
                    else None,
                )
                for row in rows
                if row["id"] in self.sources
            ]

    def configure(self, source_id, enabled=None, interval_seconds=None):
        if enabled is not None and not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        if interval_seconds is not None and (
            type(interval_seconds) is not int or interval_seconds < 60
        ):
            raise ValueError("interval_seconds must be an integer of at least 60")
        with closing(self.connect()) as db, db:
            changed = db.execute(
                """
                UPDATE source SET enabled = COALESCE(?, enabled),
                    interval_seconds = COALESCE(?, interval_seconds) WHERE id = ?
            """,
                (enabled, interval_seconds, source_id),
            )
            if not changed.rowcount:
                raise KeyError(source_id)

    def subscriptions(self, principal):
        with closing(self.connect()) as db:
            rows = db.execute(
                """
                SELECT s.id, u.subscribed_at, s.last_sync_at, s.article_list_updated_at
                FROM subscription u JOIN source s ON s.id = u.source_id
                WHERE u.principal = ? ORDER BY s.id
            """,
                (principal,),
            )
            return [
                dict(self.sources[row["id"]], **dict(row))
                for row in rows
                if row["id"] in self.sources
            ]

    def subscribe(self, principal, ids, enabled):
        if any(source_id not in self.sources for source_id in ids):
            raise ValueError("unknown source")
        with closing(self.connect()) as db, db:
            if enabled:
                subscribed_at = int(time())
                db.executemany(
                    "INSERT OR IGNORE INTO subscription VALUES (?, ?, ?)",
                    ((principal, source_id, subscribed_at) for source_id in ids),
                )
            else:
                db.executemany(
                    "DELETE FROM subscription WHERE principal = ? AND source_id = ?",
                    ((principal, source_id) for source_id in ids),
                )

    def pending(self, source_id):
        with closing(self.connect()) as db:
            return [
                json.loads(row["item"])
                for row in db.execute(
                    "SELECT item FROM pending_item WHERE source_id = ? ORDER BY item",
                    (source_id,),
                )
            ]

    def begin(self, source_id):
        now = int(time())
        with closing(self.connect()) as db, db:
            db.execute(
                "UPDATE source SET last_attempt_at = ?, active_since = ? WHERE id = ?",
                (now, now, source_id),
            )

    @staticmethod
    def _finish(db, source_id, result, finished_at):
        started_at = db.execute(
            "SELECT active_since FROM source WHERE id = ?", (source_id,)
        ).fetchone()[0]
        if started_at is None:
            started_at = finished_at
        summary = {key: value for key, value in result.items() if key != "items"}
        summary.update(started_at=started_at, finished_at=finished_at)
        db.execute(
            "INSERT INTO collection_run (source_id, summary) VALUES (?, ?)",
            (source_id, encode(summary)),
        )
        db.execute(
            "UPDATE source SET last_attempt_at = ?, active_since = NULL WHERE id = ?",
            (started_at, source_id),
        )

    def fail(self, source_id, error):
        result = {
            "status": "failed",
            "new": 0,
            "updated": 0,
            "unchanged": 0,
            "failed": 1,
            "errors": [str(error)],
        }
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self._finish(db, source_id, result, int(time()))

    def recent_runs(self, source_id, limit=20):
        with closing(self.connect()) as db:
            return [
                json.loads(row[0])
                for row in db.execute(
                    "SELECT summary FROM collection_run WHERE source_id = ? ORDER BY id DESC LIMIT ?",
                    (source_id, limit),
                )
            ]

    @staticmethod
    def _identify(db, source_id, item, now):
        native_id, url = item["native_id"], item["original_url"]
        row = db.execute(
            "SELECT id FROM article WHERE source_id = ? AND native_id = ?",
            (source_id, native_id),
        ).fetchone()
        if row is None:
            # An explicit new issue on a reused URL must stay distinct. A formerly
            # anonymous record may acquire its native ID without changing public ID.
            matches = db.execute(
                """
                SELECT a.id FROM article_url u JOIN article a ON a.id = u.article_id
                WHERE u.url = ? AND a.source_id = ? AND (? IS NULL OR a.native_id IS NULL)
            """,
                (url, source_id, native_id),
            ).fetchall()
            if len(matches) > 1:
                raise AmbiguousArticleURL("详情链接对应多篇文章，等待来源提供条目标识")
            row = matches[0] if matches else None
        if row is None:
            # Preserve the prototype's published ID for native records. Use a
            # different namespace for URL-only records to avoid collisions.
            namespace = (
                NAMESPACE_URL
                if native_id is not None
                else uuid5(NAMESPACE_URL, source_id)
            )
            key = f"{source_id}/{native_id}" if native_id is not None else url
            article_id = str(uuid5(namespace, key))
            db.execute(
                "INSERT INTO article VALUES (?, ?, ?, ?, ?)",
                (
                    article_id,
                    source_id,
                    native_id,
                    now,
                    encode(item.get("metadata", {})),
                ),
            )
        else:
            article_id = row["id"]
            db.execute(
                "UPDATE article SET native_id = COALESCE(native_id, ?), metadata = ? WHERE id = ?",
                (native_id, encode(item.get("metadata", {})), article_id),
            )
        db.execute(
            "INSERT OR IGNORE INTO article_url (url, article_id) VALUES (?, ?)",
            (url, article_id),
        )
        return article_id

    def apply(self, source_id, articles, failures, preview=False):
        failures = list(failures)
        result = {
            "items": [],
            "new": 0,
            "updated": 0,
            "unchanged": 0,
        }
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            now = int(time())
            previous = db.execute(
                "SELECT article_list_updated_at FROM source WHERE id = ?", (source_id,)
            ).fetchone()
            if previous is None:
                raise KeyError(source_id)
            revision = max(now, (previous[0] or 0) + 1)
            # Stage identity resolutions before versioning. Several discoveries
            # of the same article in one batch produce exactly one version.
            identified = {}
            # Resolve known IDs first so an anonymous row cannot overwrite one
            # of several distinct issues sharing a URL in this same batch.
            for item in sorted(articles, key=lambda entry: entry["native_id"] is None):
                try:
                    article_id = self._identify(db, source_id, item, now)
                except AmbiguousArticleURL as error:
                    failures.append({"item": item["discovery"], "error": str(error)})
                    continue
                if article_id not in identified or item["native_id"] is not None:
                    identified[article_id] = item
            for article_id, item in identified.items():
                content = {key: item[key] for key in ARTICLE_KEYS}
                content["fields"] = item["fields"]
                payload = encode(content)
                digest = hashlib.sha256(payload.encode()).hexdigest()
                latest = db.execute(
                    """SELECT digest, json_extract(content, '$.fields.page_progress')
                       FROM version WHERE article_id = ? ORDER BY revision DESC LIMIT 1""",
                    (article_id,),
                ).fetchone()
                if item.get("progress_unavailable") and latest and latest[1]:
                    # The API and the target event page may recover at different times.
                    continue
                status = "unchanged"
                if latest is None or latest[0] != digest:
                    status = "new" if latest is None else "updated"
                    db.execute(
                        "INSERT INTO version VALUES (?, ?, ?, ?, ?)",
                        (
                            article_id,
                            revision,
                            publish_timestamp(item["publish_date"]),
                            digest,
                            payload,
                        ),
                    )
                result[status] += 1
                result["items"].append(dict(content, id=article_id, status=status))

            result["errors"] = []
            for failure in failures:
                item = failure["item"]
                label = item.get("title") or item.get("id") or item.get("url")
                reason = str(failure["error"])
                result["errors"].append(f"{label} · {reason}" if label else reason)
            result["failed"] = len(failures)
            result["status"] = (
                "success"
                if not failures
                else ("partial" if result["items"] else "failed")
            )
            if preview:
                db.rollback()
                return result

            db.execute("DELETE FROM pending_item WHERE source_id = ?", (source_id,))
            db.executemany(
                "INSERT OR IGNORE INTO pending_item VALUES (?, ?)",
                ((source_id, encode(failure["item"])) for failure in failures),
            )
            changed_at = revision if result["new"] or result["updated"] else None
            db.execute(
                """
                UPDATE source SET last_sync_at = COALESCE(?, last_sync_at),
                    article_list_updated_at = COALESCE(?, article_list_updated_at) WHERE id = ?
            """,
                (None if result["status"] == "failed" else now, changed_at, source_id),
            )
            self._finish(db, source_id, result, now)
        return result

    def page(
        self,
        source_id,
        *,
        page=1,
        page_size=20,
        min_create_time=None,
        max_create_time=None,
        bootstrap=False,
    ):
        if page < 1 or page_size < 1:
            raise ValueError("page and page_size must be positive")
        minimum = min_create_time if min_create_time is not None else 0
        with closing(self.connect()) as db:
            db.execute("BEGIN")
            row = db.execute(
                "SELECT article_list_updated_at FROM source WHERE id = ?", (source_id,)
            ).fetchone()
            if row is None:
                raise KeyError(source_id)
            current = row[0] or 0
            upper = (
                current if max_create_time is None else min(current, max_create_time)
            )
            # Each record selects its newest version *inside this snapshot*, so
            # later edits cannot remove it from a page still being consumed.
            selection = """
                FROM article a JOIN version v ON v.article_id = a.id AND v.revision = (
                    SELECT MAX(old.revision) FROM version old
                    WHERE old.article_id = a.id AND old.revision BETWEEN ? AND ?
                )
                WHERE a.source_id = ?
            """
            bounds = (minimum, upper, source_id)
            order = (
                "COALESCE(v.publish_time, v.revision) DESC, a.id DESC"
                if bootstrap
                else "v.revision DESC, a.id DESC"
            )
            rows = db.execute(
                "SELECT a.id, v.revision, v.content "
                + selection
                + " ORDER BY "
                + order
                + " LIMIT ? OFFSET ?",
                (*bounds, page_size, (page - 1) * page_size),
            ).fetchall()
            total = (
                len(rows)
                if bootstrap
                else db.execute("SELECT COUNT(*) " + selection, bounds).fetchone()[0]
            )
        articles = []
        for row in rows:
            content = json.loads(row["content"])
            content.pop("fields")
            articles.append(
                dict(
                    content,
                    id=row["id"],
                    create_time=row["revision"],
                    update_time=row["revision"],
                )
            )
        return articles, total, upper
