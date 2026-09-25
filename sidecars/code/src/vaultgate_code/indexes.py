"""The indexes a query reads: variants built on demand, loaded lazily, merged when several.

A variant not yet built is built in the build child, one flight per snapshot and variant; a
built one is loaded from disk once, one flight per snapshot and variant, and kept in the
memory budget (`vaultgate_code.memory`); several are merged as `semble`'s MCP server merges
repositories, and the merge is kept too while its parts stay loaded.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from vaultgate_code import engine, rules
from vaultgate_code.extract import Abandoned
from vaultgate_code.memory import Name, resident_bytes
from vaultgate_code.service import Service, abandoned

if TYPE_CHECKING:
    from semble import SembleIndex

    from vaultgate_code.snapshot import Snapshot


@dataclass(frozen=True)
class Part:
    """One index of a query: its snapshot, its variant and the loaded index (None if empty)."""

    label: str
    snapshot: Snapshot
    variant: str
    info: dict[str, Any]
    index: SembleIndex | None


def part(
    service: Service, label: str, snapshot: Snapshot, content: tuple[str, ...], protect: set[Name]
) -> Part:
    """The variant of `snapshot` for `content`, built and loaded as needed (single flight)."""
    name = rules.variant_name(content)
    info = snapshot.variants.get(name)
    if info is None:
        info = service.flights.run(
            ("variant", snapshot.key, name), lambda: build_on_demand(service, snapshot, content)
        )
    index = None
    if info["chunks"]:
        index = service.loaded.get(((snapshot.key, name),))
        if index is None:
            index = service.flights.run(
                ("load", snapshot.key, name), lambda: load(service, snapshot, name, info, protect)
            )
    return Part(label, snapshot, name, info, index)


def build_on_demand(
    service: Service, snapshot: Snapshot, content: tuple[str, ...]
) -> dict[str, Any]:
    """Build a variant a query needs into its snapshot; a flight that joins late finds it built."""
    name = rules.variant_name(content)
    known = snapshot.variants.get(name)
    if known is not None:
        return known
    store = service.store
    with service.building():
        staged = store.staging()
        try:
            tree = store.path(snapshot.key) / "tree"
            info = service.build_variant(
                tree, staged / name, content, snapshot.build_timeout_s, snapshot.cancelled, None
            )
            store.add_variant(snapshot, name, staged / name, info)
        except Abandoned:
            raise abandoned(snapshot.key) from None
        finally:
            shutil.rmtree(staged, ignore_errors=True)
    return info


def load(
    service: Service, snapshot: Snapshot, name: str, info: dict[str, Any], protect: set[Name]
) -> SembleIndex:
    """Load a built variant, measuring its size as the growth in resident memory."""
    entry: Name = ((snapshot.key, name),)
    known = service.loaded.get(entry)
    if known is not None:
        return known
    with service.loaded.measure_lock:
        before = resident_bytes()
        index = engine.load_variant(str(service.store.path(snapshot.key) / "variants" / name))
        size = max(resident_bytes() - before, info["storage_bytes"])
    service.loaded.put(entry, index, size, protect)
    return index


def combined(service: Service, parts: list[Part]) -> SembleIndex | None:
    """One index as it is; several merged as semble's MCP server merges repositories."""
    if len(parts) == 1:
        return parts[0].index
    present = [(p, p.index) for p in parts if p.index is not None]
    if not present:
        return None
    name: Name = tuple((p.snapshot.key, p.variant, p.label) for p, _ in present)
    known = service.loaded.get(name)
    if known is not None:
        return known
    protect: set[Name] = {((p.snapshot.key, p.variant),) for p, _ in present}
    with service.loaded.measure_lock:
        before = resident_bytes()
        merged = engine.merge([(p.label, index) for p, index in present])
        floor = sum(p.info["storage_bytes"] for p, _ in present)
        size = max(resident_bytes() - before, floor)
    service.loaded.put(name, merged, size, protect)
    return merged
