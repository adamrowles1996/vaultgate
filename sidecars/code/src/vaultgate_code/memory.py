"""Loaded variants and merged indexes, kept least-recently-used within a memory budget.

Each entry's size is the growth in resident memory measured while it was loaded (loads are
serialised so the measurement is its own), floored at its size on disk, because memory freed
by an earlier eviction can be reused without the resident size growing. After a drop,
`malloc_trim(0)` hands freed heap back to the operating system.

A query may hold more than the budget while it runs, because the indexes it reads cannot be
dropped under it. Room is made before each load or merge (`reserve`), and once the query has
answered the budget holds again (`settle`), so no overshoot outlives the query that caused it.
"""

from __future__ import annotations

import ctypes
import os
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from semble import SembleIndex

# A loaded variant is named ((key, variant),); a merge ((key, variant, label), ...).
Name = tuple[tuple[str, ...], ...]


def is_variant(name: Name) -> bool:
    """True for a variant's name, False for a merge's."""
    return len(name) == 1 and len(name[0]) == 2  # noqa: PLR2004 - (key, variant)


def resident_bytes() -> int:
    """Return the resident set size of the process."""
    with open("/proc/self/statm", encoding="ascii") as statm:
        return int(statm.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")


def load_trim(library: str = "libc.so.6") -> Callable[[], None]:
    """Return `malloc_trim(0)` from glibc, or a no-op where there is none (musl)."""
    try:
        trim = ctypes.CDLL(library).malloc_trim
    except (OSError, AttributeError):
        return lambda: None
    trim.argtypes = [ctypes.c_size_t]
    trim.restype = ctypes.c_int

    def release() -> None:
        trim(0)

    return release


@dataclass
class _Entry:
    index: SembleIndex
    size: int


class Loaded:
    """The in-memory indexes: one per (key, variant), and merges of several."""

    def __init__(self, budget: int, trim: Callable[[], None]) -> None:
        """Keep entries while their sizes sum to at most `budget` bytes."""
        self.budget = budget
        self._trim = trim
        self._entries: OrderedDict[Name, _Entry] = OrderedDict()
        self._lock = threading.Lock()
        # Loads and merges run one at a time, so each measured growth is its own.
        self.measure_lock = threading.Lock()

    def get(self, name: Name) -> SembleIndex | None:
        """The entry, marked most recently used, or None."""
        with self._lock:
            entry = self._entries.get(name)
            if entry is None:
                return None
            self._entries.move_to_end(name)
            return entry.index

    def put(self, name: Name, index: SembleIndex, size: int, protect: set[Name]) -> None:
        """Insert an entry, then drop the least recently used until the budget holds.

        Nothing in `protect` is dropped. An entry larger than the whole budget stays, alone.
        """
        with self._lock:
            self._entries[name] = _Entry(index, size)
            self._entries.move_to_end(name)
            dropped = self._shed(self.budget, protect | {name})
        if dropped:
            self._trim()

    def reserve(self, size: int, protect: set[Name]) -> None:
        """Before loading or merging about `size` bytes, drop the least recently used to fit it.

        Nothing in `protect` is dropped, so the peak of a query is what it reads, not that plus
        everything an earlier query left loaded.
        """
        with self._lock:
            dropped = self._shed(self.budget - size, protect)
        if dropped:
            self._trim()

    def settle(self) -> None:
        """Once a query has answered, drop the least recently used until the budget holds again.

        The most recently used variant stays even when it alone is larger than the budget, so a
        variant larger than the whole budget is still served, alone, without loading it again.
        """
        with self._lock:
            newest = next((n for n in reversed(self._entries) if is_variant(n)), None)
            dropped = self._shed(self.budget, set() if newest is None else {newest})
        if dropped:
            self._trim()

    def _shed(self, limit: int, keep: set[Name]) -> bool:
        """Drop the least recently used entries outside `keep` until the total is within `limit`."""
        dropped = False
        for victim in [n for n in self._entries if n not in keep]:
            if self._total() <= limit:
                break
            if victim in self._entries:
                self._drop(victim)
                dropped = True
        return dropped

    def _total(self) -> int:
        return sum(entry.size for entry in self._entries.values())

    def _drop(self, name: Name) -> None:
        """Drop an entry; dropping a variant drops every merge it is a part of."""
        del self._entries[name]
        if is_variant(name):
            for merge in [n for n in self._entries if any(p[:2] == name[0] for p in n)]:
                del self._entries[merge]

    def drop_key(self, key: str) -> None:
        """Drop every entry built from a snapshot (it was deleted or evicted from disk)."""
        with self._lock:
            names = [n for n in self._entries if any(part[0] == key for part in n)]
            for name in names:
                self._entries.pop(name, None)
        if names:
            self._trim()

    def usage(self) -> tuple[int, int]:
        """(loaded variants, estimated bytes of every entry, merges included)."""
        with self._lock:
            return sum(1 for n in self._entries if is_variant(n)), self._total()
