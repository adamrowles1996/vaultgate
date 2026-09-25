"""Start-up reconciliation and variant invalidation (PROTOCOL.md, storage and memory)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

import archives
from conftest import ServiceFactory, put
from vaultgate_code import query

SMALL = [
    archives.file("a.py", "def invoice_total():\n    return 1\n"),
    archives.file("b.md", "# b\n"),
]


def meta_of(state: Path, key: str) -> dict[str, Any]:
    """A snapshot's meta.json."""
    meta: dict[str, Any] = json.loads((state / "snapshots" / key / "meta.json").read_text())
    return meta


def search(service: Any, key: str) -> dict[str, Any]:
    """Search one snapshot's code variant."""
    return query.search(
        service,
        {
            "indexes": [{"key": key, "label": key}],
            "content": ["code"],
            "query": "invoice",
            "top_k": 3,
            "max_snippet_lines": 0,
        },
    )


def test_start_up_removes_what_it_cannot_trust(
    make_service: ServiceFactory, tmp_path: Path
) -> None:
    """ACT-113: tmp/ is emptied and snapshots with unreadable metadata are deleted."""
    state = tmp_path / "state"
    service = make_service(state=state)
    for key in ("good", "bad-json", "bad-type", "wrong-key", "no-tree", "tree-link"):
        put(service, key, SMALL, variants=[])
    snapshots = state / "snapshots"
    (snapshots / "bad-json" / "meta.json").write_text("{")
    bad_type = meta_of(state, "bad-type") | {"files": "12"}
    (snapshots / "bad-type" / "meta.json").write_text(json.dumps(bad_type))
    (snapshots / "wrong-key" / "meta.json").write_text(json.dumps(meta_of(state, "good")))
    shutil.rmtree(snapshots / "no-tree" / "tree")
    shutil.rmtree(snapshots / "tree-link" / "tree")
    (snapshots / "tree-link" / "tree").symlink_to(snapshots / "good" / "tree")
    (snapshots / "Not A Key").mkdir()
    (snapshots / "stray-file").write_text("x")
    (snapshots / "linked").symlink_to(snapshots / "good")
    (state / "tmp" / "build-in-progress").mkdir()
    (state / "tmp" / "build-in-progress" / "x").write_text("x")
    (state / "tmp" / "leftover.json").write_text("{}")
    restarted = make_service(state=state)
    assert sorted(p.name for p in snapshots.iterdir()) == ["good"]
    assert list((state / "tmp").iterdir()) == []
    assert [s.key for s in restarted.store.all()] == ["good"]
    assert (snapshots / "good" / "tree" / "a.py").exists()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("semble", "0.6.0"),
        ("model_revision", "0" * 40),
        ("model", "someone/else"),
        ("cache_format", 2),
    ],
)
def test_a_variant_from_another_semble_or_model_is_rebuilt(
    make_service: ServiceFactory, tmp_path: Path, field: str, value: object
) -> None:
    """ACT-113: a variant built with another semble, model, revision or format is rebuilt."""
    state = tmp_path / "state"
    put(make_service(state=state), "acme", SMALL)
    meta = meta_of(state, "acme")
    meta["variants"]["code"][field] = value
    (state / "snapshots" / "acme" / "meta.json").write_text(json.dumps(meta))
    restarted = make_service(state=state)
    assert restarted.store.get("acme").variants == {}  # type: ignore[union-attr]
    assert not (state / "snapshots" / "acme" / "variants" / "code").exists()
    assert search(restarted, "acme")["results"]
    rebuilt = meta_of(state, "acme")["variants"]["code"]
    assert rebuilt[field] == restarted.versions[field]


def test_variants_missing_or_unrecorded_on_disk_are_dropped(
    make_service: ServiceFactory, tmp_path: Path
) -> None:
    """ACT-107: a recorded variant missing on disk is dropped; an unrecorded directory removed."""
    state = tmp_path / "state"
    put(make_service(state=state), "acme", SMALL, variants=[["code"], ["docs"]])
    variants = state / "snapshots" / "acme" / "variants"
    shutil.rmtree(variants / "docs")
    (variants / "config").mkdir()
    restarted = make_service(state=state)
    assert set(restarted.store.get("acme").variants) == {"code"}  # type: ignore[union-attr]
    assert sorted(p.name for p in variants.iterdir()) == ["code"]
    assert meta_of(state, "acme")["storage_bytes"] == restarted.store.usage()[1]


def test_start_up_enforces_the_caps_once(make_service: ServiceFactory, tmp_path: Path) -> None:
    """ACT-107: start-up enforces max_snapshots and max_storage_bytes, oldest first."""
    state = tmp_path / "state"
    service = make_service(state=state)
    for key in ("one", "two", "three"):
        put(service, key, SMALL, variants=[])
    restarted = make_service(state=state, max_snapshots=2)
    assert [s.key for s in restarted.store.all()] == ["three", "two"]


def test_a_moved_install_still_loads_its_variants(
    make_service: ServiceFactory, tmp_path: Path
) -> None:
    """ACT-113: the model path semble's metadata records is not trusted; a moved state loads."""
    state = tmp_path / "state"
    put(make_service(state=state), "acme", SMALL)
    saved = json.loads(
        (state / "snapshots" / "acme" / "variants" / "code" / "metadata.json").read_text()
    )
    assert (saved["model_path"], saved["root_path"]) == ("pinned", None)
    moved = tmp_path / "moved"
    state.rename(moved)
    assert search(make_service(state=moved), "acme")["results"]
