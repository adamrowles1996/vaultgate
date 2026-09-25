"""Disk caps and the memory budget, least recently used first out (PROTOCOL.md)."""

from __future__ import annotations

from typing import Any

import pytest

import archives
from conftest import ServiceFactory, put
from vaultgate_code import engine, indexes, query
from vaultgate_code.errors import ApiError
from vaultgate_code.service import Service

SMALL = [
    archives.file("a.py", "def invoice_total():\n    return 1\n"),
    archives.file("b.md", "# b\n\n" + "Billing notes. " * 64 + "\n"),  # about 1 KB of tree
]


def keys(service: Service) -> list[str]:
    """The snapshots on disk."""
    return sorted(p.name for p in service.store.snapshots_dir.iterdir())


def search(service: Service, *indexes: str, content: list[str] | None = None) -> dict[str, Any]:
    """Search some snapshots, each labelled by its key."""
    return query.search(
        service,
        {
            "indexes": [{"key": k, "label": k} for k in indexes],
            "content": content or ["code"],
            "query": "invoice",
            "top_k": 3,
            "max_snippet_lines": 0,
        },
    )


def test_the_snapshot_cap_evicts_the_least_recently_used(make_service: ServiceFactory) -> None:
    """ACT-107: beyond max_snapshots, the least recently used snapshot goes first."""
    service = make_service(max_snapshots=2)
    put(service, "first", SMALL, variants=[])
    put(service, "second", SMALL, variants=[])
    query.read(service, {"key": "first", "file_path": "a.py", "max_lines": 1})  # first is now newer
    put(service, "third", SMALL, variants=[])
    assert keys(service) == ["first", "third"]
    assert service.health()["usage"]["snapshots"] == 2


def test_the_storage_cap_evicts_until_the_new_snapshot_fits(make_service: ServiceFactory) -> None:
    """ACT-107: beyond max_storage_bytes, least recently used snapshots go until it fits."""
    service = make_service()
    size = put(service, "one", SMALL, variants=[["code"]])["storage_bytes"]
    service.store.max_storage_bytes = size * 5 // 2  # room for two, not three
    put(service, "two", SMALL, variants=[["code"]])
    put(service, "three", SMALL, variants=[["code"]])
    assert keys(service) == ["three", "two"]
    assert service.store.usage()[0] == 2


def test_a_snapshot_in_use_is_never_evicted(make_service: ServiceFactory) -> None:
    """ACT-107: a snapshot in use is never evicted; storage_full if nothing else can go."""
    service = make_service(max_snapshots=1)
    put(service, "busy", SMALL, variants=[])
    with service.store.using(["busy"]):
        with pytest.raises(ApiError) as caught:
            put(service, "new", SMALL, variants=[])
        assert (caught.value.status, caught.value.code) == (507, "storage_full")
    assert keys(service) == ["busy"]
    put(service, "new", SMALL, variants=[])
    assert keys(service) == ["new"]


def test_a_snapshot_larger_than_the_storage_cap_is_storage_full(
    make_service: ServiceFactory,
) -> None:
    """ACT-107: a snapshot that cannot fit even alone is 507 storage_full; nothing is evicted."""
    service = make_service(max_storage_bytes=100_000)
    put(service, "kept", SMALL, variants=[])
    big = [archives.file(f"f{n}.txt", bytes(30_000)) for n in range(4)]
    with pytest.raises(ApiError) as caught:
        put(service, "big", big, variants=[])
    assert caught.value.code == "storage_full"
    assert keys(service) == ["kept"]
    assert not list(service.store.tmp_dir.iterdir())


def test_an_on_demand_variant_evicts_others_or_is_storage_full(
    make_service: ServiceFactory,
) -> None:
    """ACT-107: a variant built for a query must fit the storage cap too."""
    service = make_service()
    tree = put(service, "old", SMALL, variants=[])["storage_bytes"]
    put(service, "current", SMALL, variants=[])
    variant = put(service, "probe", SMALL)["storage_bytes"] - tree
    service.delete("probe")
    # Room for current and its variant, not old too (variant sizes vary by a few bytes).
    service.store.max_storage_bytes = 2 * tree + variant - tree // 2
    search(service, "current")
    assert keys(service) == ["current"]
    service.store.max_storage_bytes = tree + variant + 100  # no room for a second variant
    with pytest.raises(ApiError) as caught:
        search(service, "current", content=["docs"])
    assert caught.value.code == "storage_full"
    assert set(service.store.get("current").variants) == {"code"}  # type: ignore[union-attr]
    assert not list(service.store.tmp_dir.iterdir())


def test_the_memory_budget_drops_the_least_recently_used(
    make_service: ServiceFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-107: loaded variants stay within max_memory_bytes; a drop calls malloc_trim."""
    # No resident growth is measured, so each variant counts its size on disk: the three are
    # the same archive and differ by a few bytes at most.
    monkeypatch.setattr(indexes, "resident_bytes", lambda: 0)
    trims: list[int] = []
    service = make_service(trim=lambda: trims.append(1))
    for key in ("a", "b", "c"):
        put(service, key, SMALL, variants=[["code"]])
    search(service, "a")
    search(service, "b")
    loaded, used = service.loaded.usage()
    assert (loaded, trims) == (2, [])
    service.loaded.budget = used + 1000  # room for two, not three
    search(service, "a")  # a is now the most recent
    search(service, "c")
    assert service.loaded.get((("a", "code"),)) is not None
    assert service.loaded.get((("b", "code"),)) is None
    assert trims == [1]


def test_a_variant_larger_than_the_budget_is_served_alone(make_service: ServiceFactory) -> None:
    """ACT-107: a variant larger than the whole budget is still served, alone."""
    service = make_service(max_memory_bytes=1)
    put(service, "a", SMALL, variants=[["code"]])
    put(service, "b", SMALL, variants=[["code"]])
    assert search(service, "a")["results"]
    assert search(service, "b")["results"]
    assert service.health()["usage"]["loaded_variants"] == 1


def test_merges_are_cached_while_their_parts_stay(
    make_service: ServiceFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-107: the merged index is cached while its parts stay loaded."""
    merges: list[int] = []
    real = engine.merge

    def counted(parts: Any) -> Any:
        merges.append(1)
        return real(parts)

    monkeypatch.setattr(engine, "merge", counted)
    service = make_service(max_memory_bytes=1)
    for key in ("a", "b", "c"):
        put(service, key, SMALL, variants=[["code"]])
    first = search(service, "a", "b")
    assert search(service, "a", "b") == first
    assert merges == [1]
    _, loaded_bytes = service.loaded.usage()
    assert service.health()["usage"]["loaded_variants"] == 2
    assert loaded_bytes > 0
    search(service, "c")  # over budget: a, b and their merge go
    assert service.health()["usage"]["loaded_variants"] == 1
    search(service, "a", "b")
    assert merges == [1, 1]


def test_deleting_a_snapshot_drops_its_loaded_variants(make_service: ServiceFactory) -> None:
    """ACT-107: a deleted or evicted snapshot leaves nothing loaded."""
    trims: list[int] = []
    service = make_service(trim=lambda: trims.append(1))
    put(service, "a", SMALL, variants=[["code"]])
    put(service, "b", SMALL, variants=[["code"]])
    search(service, "a", "b")
    service.delete("a")
    assert service.loaded.usage()[0] == 1
    assert trims == [1]
    service.delete("b")
    assert service.loaded.usage() == (0, 0)
