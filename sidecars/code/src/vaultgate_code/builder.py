"""Variant builds in a child process, and single flight for work several requests wait on.

A build runs `semble` in a child started with the `spawn` method, so the memory it needs is
returned to the operating system when it exits and a timeout is a real kill. The child talks
back over a one-way pipe with nothing but its counts or its exception's class name; its own
standard output and error are closed, so nothing it prints can reach the logs.
"""

from __future__ import annotations

import multiprocessing
import threading
import time
from collections.abc import Callable, Hashable, Sequence
from dataclasses import dataclass, field
from multiprocessing.connection import Connection, wait
from typing import Any

from vaultgate_code.errors import ApiError
from vaultgate_code.extract import Abandoned

POLL_S = 0.1
EXIT_GRACE_S = 10


@dataclass
class _Flight:
    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: BaseException | None = None


class Flights:
    """Run one computation per key at a time; later callers wait for the running one."""

    def __init__(self) -> None:
        """Start with nothing running."""
        self._lock = threading.Lock()
        self._running: dict[Hashable, _Flight] = {}

    def run(self, key: Hashable, work: Callable[[], Any]) -> Any:
        """Return `work()`, or the result (or exception) of the same key's running call."""
        with self._lock:
            flight = self._running.get(key)
            owner = flight is None
            if flight is None:
                flight = self._running[key] = _Flight()
        if not owner:
            flight.done.wait()
            if flight.error is not None:
                raise flight.error
            return flight.result
        try:
            flight.result = work()
        except BaseException as error:
            flight.error = error
            raise
        finally:
            with self._lock:
                if self._running.get(key) is flight:
                    del self._running[key]
            flight.done.set()
        return flight.result

    def forget(self, key: Hashable) -> None:
        """Let the next caller of `key` start afresh rather than join the running call."""
        with self._lock:
            self._running.pop(key, None)


class Runner:
    """Build variants in child processes, at most `concurrency` at once."""

    def __init__(self, model_dir: str, concurrency: int, target: Callable[..., None]) -> None:
        """`target` is the child's entry point (`vaultgate_code.child.main`)."""
        self._model_dir = model_dir
        self._slots = threading.BoundedSemaphore(concurrency)
        self._target = target
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._children: set[multiprocessing.process.BaseProcess] = set()

    @property
    def running(self) -> int:
        """Children alive now."""
        with self._lock:
            return len(self._children)

    def build(
        self, tree: str, out: str, content: Sequence[str], timeout_s: float, cancel: threading.Event
    ) -> tuple[int, int, int]:
        """Build one variant; return (files, chunks, duration in ms).

        Raises 422 `build_timeout` when the child outlives `timeout_s`, 422 `build_failed`
        when it fails, and Abandoned when `cancel` is set meanwhile; the child is killed.
        """
        with self._slots:
            if cancel.is_set():
                raise Abandoned
            receiver, sender = self._context.Pipe(duplex=False)
            child = self._context.Process(
                target=self._target,
                args=(tree, out, list(content), self._model_dir, sender),
                daemon=True,
            )
            started = time.monotonic()
            child.start()
            sender.close()
            with self._lock:
                self._children.add(child)
            try:
                message = self._await(receiver, started + timeout_s, cancel)
                child.join(EXIT_GRACE_S)  # it has answered: let it exit on its own
            finally:
                receiver.close()
                self._reap(child)
        duration_ms = round((time.monotonic() - started) * 1000)
        if "error" in message:
            raise ApiError(422, "build_failed", str(message["error"]))
        return int(message["files"]), int(message["chunks"]), duration_ms

    @staticmethod
    def _await(receiver: Connection, deadline: float, cancel: threading.Event) -> dict[str, Any]:
        while True:
            remaining = deadline - time.monotonic()
            if cancel.is_set():
                raise Abandoned
            if remaining <= 0:
                raise ApiError(422, "build_timeout", "the build exceeded build_timeout_s")
            if wait([receiver], min(POLL_S, remaining)):
                try:
                    message: dict[str, Any] = receiver.recv()
                except EOFError:
                    message = {"error": "ChildExited"}
                return message

    def _reap(self, child: multiprocessing.process.BaseProcess) -> None:
        if child.exitcode is None:
            child.kill()
        child.join()
        with self._lock:
            self._children.discard(child)
        child.close()

    def stop(self) -> None:
        """Kill every child (shutdown)."""
        with self._lock:
            for child in self._children:
                child.kill()
