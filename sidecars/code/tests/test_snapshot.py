"""A snapshot's `meta.json` is read strictly; anything else is unreadable (PROTOCOL.md)."""

from __future__ import annotations

from typing import Any

import pytest

from vaultgate_code.snapshot import Snapshot

VERSIONS = {"semble": "0.6.1", "cache_format": 1, "model": "m", "model_revision": "r"}
VARIANT = {"files": 1, "chunks": 2, "built_at": 3, "duration_ms": 4, "storage_bytes": 5}


def record(**changes: Any) -> dict[str, Any]:
    """A valid record with some fields replaced."""
    return {
        "key": "acme",
        "owner": "target-1",
        "commit": "0" * 40,
        "created_at": 1,
        "last_used_at": 2,
        "files": 3,
        "bytes": 4,
        "skipped": {"links": 0, "special": 0, "excluded": 0, "large": 0},
        "storage_bytes": 5,
        "build_timeout_s": 600,
        "variants": {"code": VARIANT | VERSIONS},
    } | changes


def test_a_record_round_trips() -> None:
    """PROTOCOL: what meta.json holds reads back to the same snapshot."""
    snapshot = Snapshot.from_record(record(), VERSIONS)
    assert snapshot.record() == record()
    assert snapshot.public()["variants"] == {"code": VARIANT}


@pytest.mark.parametrize(
    ("data", "error"),
    [
        ([], TypeError),
        (record(key=1), TypeError),
        (record(files=-1), TypeError),
        (record(files=True), TypeError),
        (record(skipped=[]), TypeError),
        (record(skipped={"links": 0}), KeyError),
        (record(variants={"code": []}), TypeError),
        (record(variants={"code": VARIANT | VERSIONS | {"chunks": "2"}}), TypeError),
        (record(variants={"code": VARIANT}), KeyError),
        ({k: v for k, v in record().items() if k != "owner"}, KeyError),
    ],
)
def test_anything_else_is_refused(data: object, error: type[Exception]) -> None:
    """PROTOCOL: a wrong type or a missing field makes the metadata unreadable."""
    with pytest.raises(error):
        Snapshot.from_record(data, VERSIONS)
