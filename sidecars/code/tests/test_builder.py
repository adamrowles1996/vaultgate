"""Single flight and the build child's runner (ACT-107)."""

from __future__ import annotations

import multiprocessing
import sys
import threading
from pathlib import Path
from types import FrameType
from typing import Any

import pytest

import childtargets
from vaultgate_code import child
from vaultgate_code.builder import Flights, Runner
from vaultgate_code.errors import ApiError
from vaultgate_code.extract import Abandoned


def waiting_in_flight(thread: threading.Thread) -> bool:
    """True once `thread` is blocked in Flights.run waiting for another caller's result."""
    frame: FrameType | None = sys._current_frames().get(thread.ident or 0)
    while frame is not None:
        if frame.f_code is Flights.run.__code__ and frame.f_locals.get("owner") is False:
            return True
        frame = frame.f_back
    return False


def join_when_waiting(thread: threading.Thread) -> None:
    """Start `thread` and return once it waits on the running flight."""
    thread.start()
    while not waiting_in_flight(thread):
        threading.Event().wait(0.01)


def test_a_joined_caller_gets_the_owner_s_result_or_error() -> None:
    """ACT-107: a second caller of a running key waits and gets that call's outcome."""
    flights = Flights()
    release = threading.Event()
    calls: list[str] = []
    outcomes: list[Any] = []

    def work(result: Any) -> Any:
        calls.append("work")
        assert release.wait(30)
        if isinstance(result, Exception):
            raise result
        return result

    def call(result: Any) -> None:
        try:
            outcomes.append(flights.run("key", lambda: work(result)))
        except ValueError as error:
            outcomes.append(error)

    for result in ("built", ValueError("failed")):
        release.clear()
        owner = threading.Thread(target=call, args=(result,))
        owner.start()
        while not calls:
            threading.Event().wait(0.01)
        joiner = threading.Thread(target=call, args=("never used",))
        join_when_waiting(joiner)
        release.set()
        owner.join()
        joiner.join()
        assert outcomes == [result, result]
        assert calls == ["work"]
        calls.clear()
        outcomes.clear()


def test_forget_lets_the_next_caller_start_afresh() -> None:
    """ACT-107: a deleted snapshot's running build is forgotten; the next PUT builds anew."""
    flights = Flights()
    release = threading.Event()
    first = threading.Thread(target=lambda: flights.run("key", lambda: release.wait(30)))
    first.start()
    while "key" not in flights._running:
        threading.Event().wait(0.01)
    flights.forget("key")
    assert flights.run("key", lambda: "fresh") == "fresh"
    release.set()
    first.join()
    assert flights._running == {}


def test_a_cancelled_build_never_starts_a_child(tmp_path: Path) -> None:
    """ACT-107: a build whose snapshot was deleted while it queued for a slot does not start."""
    runner = Runner("/model", 1, childtargets.sleep_forever)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Abandoned):
        runner.build(str(tmp_path), str(tmp_path / "out"), ["code"], 60, cancel)
    assert runner.running == 0


def test_stop_kills_running_children(tmp_path: Path) -> None:
    """ACT-107: shutdown kills every build child; the build fails rather than hangs."""
    runner = Runner("/model", 2, childtargets.sleep_forever)
    errors: list[ApiError] = []

    def build() -> None:
        with pytest.raises(ApiError) as caught:
            runner.build(str(tmp_path), str(tmp_path / "out"), ["code"], 600, threading.Event())
        errors.append(caught.value)

    worker = threading.Thread(target=build)
    worker.start()
    while runner.running == 0:
        threading.Event().wait(0.05)
    runner.stop()
    worker.join()
    assert (errors[0].code, errors[0].message) == ("build_failed", "ChildExited")
    assert multiprocessing.active_children() == []


def test_the_real_child_reports_a_failure_by_class_name_only(
    tmp_path: Path, model_dir: Path
) -> None:
    """ACT-107: a failing semble build crosses to the parent as its exception's class name."""
    runner = Runner(str(model_dir), 1, child.main)
    with pytest.raises(ApiError) as caught:
        runner.build(
            str(tmp_path / "absent"), str(tmp_path / "out"), ["code"], 120, threading.Event()
        )
    assert (caught.value.status, caught.value.code) == (422, "build_failed")
    assert caught.value.message == "FileNotFoundError"
