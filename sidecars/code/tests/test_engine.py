"""`semble` as a library: the pinned version and model, and what is neutralised (ACT-113)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import semble.index.index as semble_index
from semble import SembleIndex

from vaultgate_code import engine
from vaultgate_code.environment import FIXED

SIDECAR = Path(__file__).resolve().parents[1]

PROBE = r"""
import json, os
import vaultgate_code.memory  # imports semble directly: the package fixed the environment first
import huggingface_hub.constants as hub
print(json.dumps({"offline": hub.HF_HUB_OFFLINE, "home": hub.HF_HOME,
                  "cache": os.environ["SEMBLE_CACHE_LOCATION"]}))
"""


def test_the_environment_is_fixed_before_semble_loads() -> None:
    """ACT-113: HF_HUB_OFFLINE=1 and a cache nowhere, whatever the caller's environment says."""
    environment = {
        **{k: v for k, v in os.environ.items() if not k.startswith(("HF_", "SEMBLE_"))},
        "PYTHONPATH": str(SIDECAR / "src"),
        "HF_HUB_OFFLINE": "0",
        "SEMBLE_CACHE_LOCATION": "/tmp/somewhere-writable",
    }
    finished = subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [sys.executable, "-c", PROBE], env=environment, capture_output=True, text=True, check=True
    )
    assert json.loads(finished.stdout) == {
        "offline": True,
        "home": FIXED["HF_HOME"],
        "cache": FIXED["SEMBLE_CACHE_LOCATION"],
    }
    assert FIXED["SEMBLE_CACHE_LOCATION"].startswith("/dev/null/")


THREADS_PROBE = r"""
import os
import vaultgate_code.memory  # numpy and semble load after the package fixed the environment
import numpy
numpy.ones((64, 64)) @ numpy.ones((64, 64))
print(len(os.listdir("/proc/self/task")))
"""


def test_the_linear_algebra_runs_on_one_thread() -> None:
    """ACT-114: one BLAS thread whatever the caller asks, so a many-CPU host's task limit holds."""
    environment = {
        **os.environ,
        "PYTHONPATH": str(SIDECAR / "src"),
        "OPENBLAS_NUM_THREADS": "64",
        "OMP_NUM_THREADS": "64",
    }
    finished = subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [sys.executable, "-c", THREADS_PROBE],
        env=environment,
        capture_output=True,
        text=True,
        check=True,
    )
    assert int(finished.stdout) <= 2
    assert FIXED["OPENBLAS_NUM_THREADS"] == FIXED["OMP_NUM_THREADS"] == "1"


def test_semble_is_the_pinned_version() -> None:
    """ACT-113: the sidecar refuses any semble but 0.6.1, whose internals it replaces."""
    engine.check_semble()
    with pytest.raises(RuntimeError, match=r"semble 0\.6\.1 is required, found 0\.7\.0"):
        engine.check_semble("0.7.0")


def test_semble_cache_and_statistics_are_replaced(model_dir: Path) -> None:
    """ACT-113: semble's cache lookups find nothing, its statistics writer writes nothing."""
    replaced = vars(semble_index)
    assert replaced["get_validated_cache"] is engine.no_cached_index
    assert replaced["load_previous_for_incremental"] is engine.no_cached_index
    assert replaced["save_search_stats"] is engine.no_statistics
    assert replaced["load_model"] is engine.pinned_model
    engine.no_cached_index("/repo", None, [])
    engine.no_statistics([], "search", {}, 3)
    model, directory = engine.pinned_model("/a/path/an/index/recorded")
    assert directory == str(model_dir)
    assert model is engine.pinned_model(None)[0]


def test_the_model_must_be_loaded_first(monkeypatch: pytest.MonkeyPatch) -> None:
    """ACT-113: nothing loads a model implicitly; the verified one must have been loaded."""
    monkeypatch.setattr(engine, "_MODEL", engine._Model())
    with pytest.raises(RuntimeError, match="the model is not loaded"):
        engine.pinned_model()


def test_a_build_failure_other_than_nothing_to_index_is_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-107: only semble's "no supported files" becomes zero chunks; anything else fails."""

    def refuse(*_arguments: Any, **_options: Any) -> SembleIndex:
        raise ValueError("Unsupported something else")

    monkeypatch.setattr(SembleIndex, "from_path", refuse)
    with pytest.raises(ValueError, match="Unsupported something else"):
        engine.build_variant(str(tmp_path), str(tmp_path / "out"), ["code"])


def test_a_merge_semble_labels_otherwise_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """ACT-110: a merge whose labels are not exactly the connection names is refused."""

    class Merged:
        sources: dict[str, str] = {"other": "https://vaultgate.invalid/other"}  # noqa: RUF012

    monkeypatch.setattr(SembleIndex, "merge", lambda _parts: Merged())
    with pytest.raises(RuntimeError, match="labelled the merged indexes unexpectedly"):
        engine.merge([("alpha", object()), ("beta", object())])  # type: ignore[list-item]
