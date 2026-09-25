"""The store's guards against snapshots that went away meanwhile (PROTOCOL.md)."""

from __future__ import annotations

from pathlib import Path

import pytest

from conftest import ServiceFactory, put
from vaultgate_code.errors import ApiError
from vaultgate_code.extract import Abandoned
from vaultgate_code.service import now_ms
from vaultgate_code.snapshot import Snapshot

SMALL_VARIANTS: list[list[str]] = []


def orphan(key: str) -> Snapshot:
    """A snapshot the store does not hold."""
    skipped = {"links": 0, "special": 0, "excluded": 0, "large": 0}
    return Snapshot(key, "target-1", "0" * 40, 1, 1, 0, 0, skipped, 0, 600)


def test_a_snapshot_deleted_before_it_is_installed_is_abandoned(
    make_service: ServiceFactory,
) -> None:
    """ACT-109: a build whose key was deleted is discarded, not installed."""
    service = make_service()
    snapshot = orphan("gone")
    snapshot.cancelled.set()
    with pytest.raises(Abandoned):
        service.store.install(service.store.staging(), snapshot)
    assert service.store.get("gone") is None


def test_a_variant_for_a_snapshot_that_went_away_is_refused(
    make_service: ServiceFactory, tmp_path: Path
) -> None:
    """ACT-109: an on-demand variant of a deleted or evicted snapshot is snapshot_missing."""
    service = make_service()
    built = tmp_path / "built"
    built.mkdir()
    with pytest.raises(ApiError) as caught:
        service.store.add_variant(orphan("gone"), "code", built, {"storage_bytes": 1})
    assert (caught.value.status, caught.value.code) == (404, "snapshot_missing")
    assert built.exists()


def test_a_use_of_a_replaced_snapshot_is_not_recorded(make_service: ServiceFactory) -> None:
    """ACT-107: last_used_at is recorded only for the snapshot the store still holds."""
    service = make_service()
    put(service, "acme", variants=SMALL_VARIANTS)
    held = service.store.get("acme")
    assert held is not None
    before = held.last_used_at
    stale = orphan("acme")
    service.store.touch([stale])
    assert (held.last_used_at, stale.last_used_at) == (before, 1)


def test_the_clock_is_milliseconds_since_the_epoch() -> None:
    """ACT-113: times are milliseconds since the epoch."""
    assert 1_700_000_000_000 < now_ms() < 10_000_000_000_000
