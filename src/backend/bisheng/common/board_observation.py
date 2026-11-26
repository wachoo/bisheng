"""Per-turn measurements for the authenticated Web assistant entry point."""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import PurePosixPath
from threading import RLock
from time import monotonic
from urllib.parse import urlsplit
from uuid import uuid4

from langchain_core.callbacks.base import BaseCallbackHandler

current_observation = ContextVar("web_board_observation", default=None)

# Known deliverable formats published by the built-in office/report skills.
# Source, config, archive and ambiguous artifacts await explicit registration.
DOCUMENT_OUTPUT_SUFFIXES = {
    ".csv",
    ".doc",
    ".docx",
    ".gif",
    ".html",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".ppt",
    ".pptx",
    ".svg",
    ".tsv",
    ".webp",
    ".xls",
    ".xlsx",
}


class BoardObservation(BaseCallbackHandler):
    """One observer per user request. Graph branches share it through ContextVar."""

    run_inline = True

    def __init__(self, asset_id, user_id, *, clock=monotonic):
        self.id = uuid4().hex
        self.asset_id = str(asset_id)
        self.user_id = user_id
        self.department_id = None
        self.clock = clock
        self.active = 0.0
        self.since = None
        self.tools = set()
        self.models = set()
        self.call_ids = {}
        self.facts = {}
        self.output_links = {}
        self.version_members = set()
        self.document_task = False
        self.started = False
        self.incomplete = False
        self.lock = RLock()

    def _tick(self, now):
        if self.since is not None and (not self.tools or self.models):
            self.active += now - self.since

    def start(self):
        self.started = True
        self.since = self.clock()

    def finish(self):
        with self.lock:
            if self.since is not None:
                self._tick(self.clock())
                self.since = None
            if not self.started or self.tools or self.models or self.incomplete:
                return None
            return round(self.active, 3)

    def _transition(self, runs, run_id, entering):
        with self.lock:
            if self.since is None:
                return
            now = self.clock()
            self._tick(now)
            self.since = now
            if entering:
                runs.add(run_id)
            elif run_id in runs:
                runs.remove(run_id)
            else:
                self.incomplete = True

    def on_tool_start(self, serialized, input_str, *, run_id, **kwargs):
        logical_id = kwargs.get("tool_call_id") or self.call_ids.get(kwargs.get("parent_run_id"))
        if logical_id:
            self.call_ids[run_id] = logical_id
        self._transition(self.tools, run_id, True)

    def on_tool_end(self, output, *, run_id, **kwargs):
        self._transition(self.tools, run_id, False)

    def on_tool_error(self, error, *, run_id, **kwargs):
        self._transition(self.tools, run_id, False)

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        self._transition(self.models, run_id, True)

    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        self._transition(self.models, run_id, True)

    def on_llm_end(self, response, *, run_id, **kwargs):
        self._transition(self.models, run_id, False)

    def on_llm_error(self, error, *, run_id, **kwargs):
        self._transition(self.models, run_id, False)

    def record(self, kind, asset_id, status, operation=None):
        key = (kind, str(asset_id), str(operation or uuid4().hex))
        with self.lock:
            if key in self.facts and kind in {"skill", "file", "version", "version_member"}:
                return
            self.facts[key] = (status, datetime.now(UTC).replace(tzinfo=None))

    def record_outputs(self, output):
        # The managed document generators explicitly publish standalone files.
        # Other code interpreter calls do not identify project/version ownership.
        if not isinstance(output, dict):
            return
        for link in output.get("file_list") or []:
            if isinstance(link, str):
                try:
                    path = urlsplit(link).path
                except ValueError:
                    continue
                if path:
                    key = sha256(path.encode()).hexdigest()
                    self.output_links[link] = key
                    if self.document_task and PurePosixPath(path).suffix.lower() in DOCUMENT_OUTPUT_SUFFIXES:
                        self.record("file", self.asset_id, "success", key)

    def register_outputs(self, links, project="", version=""):
        """Only accept storage objects this run actually generated."""
        if bool(project.strip()) != bool(version.strip()):
            return "Provide both project and version for a code delivery."
        if not links or any(link not in self.output_links for link in links):
            return "Use the exact published file links returned by this task's code interpreter."
        keys = {self.output_links[link] for link in links}
        if project.strip():
            # The caller supplies the stable project identifier. The repository scopes it to the tenant.
            project_version = sha256(repr((project.strip(), version.strip())).encode()).hexdigest()
            self.record("version", self.asset_id, "success", project_version)
            for key in keys:
                self.version_members.add(key)
                self.record("version_member", project_version, "included", key)
        else:
            for key in keys - self.version_members:
                self.record("file", self.asset_id, "success", key)
        return "Delivery recorded."


@contextmanager
def observe_knowledge(name, run_manager=None):
    observation = current_observation.get()
    prefix, separator, asset = name.partition("_")
    if observation is None or prefix != "knowledge" or not separator or not asset.isdigit():
        yield
        return
    run_id = getattr(run_manager, "run_id", None)
    operation = observation.call_ids.get(run_id, run_id)
    try:
        yield
    except Exception:
        observation.record("knowledge", asset, "failed", operation)
        raise
    else:
        observation.record("knowledge", asset, "success", operation)
