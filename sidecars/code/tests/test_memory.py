"""The memory budget's bookkeeping (PROTOCOL.md, storage and memory; ACT-107)."""

from __future__ import annotations

from typing import Any, cast

from semble import SembleIndex

from vaultgate_code.memory import Loaded, Name, is_variant, load_trim, resident_bytes


def index(label: str) -> SembleIndex:
    """A stand-in for a loaded index: the bookkeeping never looks inside one."""
    return cast("SembleIndex", label)


A: Name = (("a", "code"),)
B: Name = (("b", "code"),)
MERGE: Name = (("a", "code", "alpha"), ("b", "code", "beta"))


def test_resident_memory_is_measured() -> None:
    """ACT-107: the estimate of a load is the growth of this process's resident set."""
    assert resident_bytes() > 1 << 20
    assert is_variant(A)
    assert not is_variant(MERGE)


def test_malloc_trim_or_nothing() -> None:
    """ACT-107: malloc_trim(0) from glibc; a C library without it gives a no-op."""
    trims: list[Any] = [load_trim(), load_trim("libm.so.6"), load_trim("libabsent.so.404")]
    for trim in trims:
        trim()


def test_a_merge_can_be_the_one_dropped() -> None:
    """ACT-107: a merge is dropped on its own when it is the least recently used entry."""
    trims: list[int] = []
    loaded = Loaded(budget=30, trim=lambda: trims.append(1))
    loaded.put(A, index("a"), 10, set())
    loaded.put(B, index("b"), 10, set())
    loaded.put(MERGE, index("merged"), 10, {A, B})
    assert (loaded.usage(), trims) == ((2, 30), [])
    assert loaded.get(A) == "a"
    assert loaded.get(B) == "b"
    loaded.put((("c", "code"),), index("c"), 10, set())
    assert loaded.get(MERGE) is None
    assert loaded.usage() == (3, 30)
    assert trims == [1]


def test_dropping_a_variant_drops_its_merges() -> None:
    """ACT-107: a merge never outlives one of its parts."""
    loaded = Loaded(budget=25, trim=lambda: None)
    loaded.put(A, index("a"), 10, set())
    loaded.put(B, index("b"), 10, set())
    loaded.put(MERGE, index("merged"), 5, {A, B})
    loaded.get(B)
    loaded.get(MERGE)
    loaded.put((("c", "code"),), index("c"), 10, set())
    assert loaded.get(A) is None
    assert loaded.get(MERGE) is None
    assert loaded.get(B) == "b"


def test_dropping_a_key_with_nothing_loaded_trims_nothing() -> None:
    """ACT-107: malloc_trim runs only after something was actually dropped."""
    trims: list[int] = []
    loaded = Loaded(budget=100, trim=lambda: trims.append(1))
    loaded.drop_key("absent")
    loaded.put(A, index("a"), 10, set())
    loaded.drop_key("a")
    assert (loaded.usage(), trims) == ((0, 0), [1])
