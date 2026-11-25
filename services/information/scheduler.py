"""One collection loop per source in the single-process Information service."""

import logging
import time
from threading import Event, Lock, Thread

logger = logging.getLogger(__name__)


class Scheduler:
    def __init__(self, store, sources, collect):
        self.store = store
        self.collect = collect
        self.locks = {key: Lock() for key in sources}
        self.wakes = {key: Event() for key in sources}
        self.generations = dict.fromkeys(sources, 0)
        self.stopped = Event()
        self.threads = []

    def start(self):
        for source_id in self.locks:
            thread = Thread(
                target=self._loop,
                args=(source_id,),
                name=f"feed-{source_id}",
                daemon=True,
            )
            self.threads.append(thread)
            thread.start()

    def stop(self):
        self.stopped.set()
        for wake in self.wakes.values():
            wake.set()
        for thread in self.threads:
            thread.join()

    def status(self, source_id):
        return next(row for row in self.store.statuses() if row["id"] == source_id)

    def configure(self, source_id, **changes):
        with self.locks[source_id]:
            result = self.store.configure(source_id, **changes)
            if changes.get("enabled") is False:
                self.generations[source_id] += 1
            self.wakes[source_id].set()
            return result

    def preview(self, source_id):
        articles, failures = self.collect(source_id, self.store.pending(source_id))
        return self.store.apply(source_id, articles, failures, preview=True)

    def _loop(self, source_id):
        wake = self.wakes[source_id]
        while not self.stopped.is_set():
            try:
                with self.locks[source_id]:
                    wake.clear()
                    state = self.status(source_id)
                    if state["enabled"]:
                        due_in = (
                            (state["last_attempt_at"] or 0)
                            + state["interval_seconds"]
                            - time.time()
                        )
                    else:
                        due_in = None
                    generation = self.generations[source_id]
                    if due_in is not None and due_in <= 0:
                        self.store.begin(source_id)
                if due_in is None or due_in > 0:
                    if not self.stopped.is_set():
                        wake.wait(due_in)
                    continue

                try:
                    articles, failures = self.collect(
                        source_id, self.store.pending(source_id)
                    )
                    with self.locks[source_id]:
                        if (
                            generation == self.generations[source_id]
                            and not self.stopped.is_set()
                        ):
                            self.store.apply(source_id, articles, failures)
                        else:
                            self.store.fail(source_id, "本轮采集已停止")
                except Exception as exc:
                    logger.exception("Collection failed for %s", source_id)
                    self.store.fail(source_id, str(exc))
            except Exception:
                logger.exception("Could not complete collection for %s", source_id)
                self.stopped.wait(5)
