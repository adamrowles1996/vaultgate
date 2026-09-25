"""The state directory: snapshots on disk, their metadata and the disk caps (PROTOCOL.md).

<state>/snapshots/<key>/meta.json
<state>/snapshots/<key>/tree/...
<state>/snapshots/<key>/variants/<variant>/   a semble save()
<state>/tmp/                                  builds in progress, emptied at start-up
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from vaultgate_code.errors import snapshot_missing, storage_full
from vaultgate_code.extract import Abandoned
from vaultgate_code.rules import KEY
from vaultgate_code.snapshot import Snapshot, disk_usage


def _remove(path: Path) -> None:
    """Remove a file, a link or a directory tree; a link is never followed."""
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


class Store:
    """Every snapshot on disk, the disk caps and least-recently-used eviction."""

    def __init__(
        self,
        root: Path,
        max_snapshots: int,
        max_storage_bytes: int,
        versions: dict[str, Any],
        on_evict: Callable[[str], None],
        clock: Callable[[], int],
    ) -> None:
        """Serve the state directory `root` (created if missing)."""
        self.snapshots_dir = root / "snapshots"
        self.tmp_dir = root / "tmp"
        self.max_snapshots = max_snapshots
        self.max_storage_bytes = max_storage_bytes
        self.versions = versions
        self.clock = clock
        self._on_evict = on_evict
        self._snapshots: dict[str, Snapshot] = {}
        self._in_use: Counter[str] = Counter()
        self.lock = threading.RLock()

    # Start-up -------------------------------------------------------------------------------

    def reconcile(self) -> None:
        """Empty tmp/, delete unreadable snapshots and stale variants, enforce the caps once."""
        for directory in (self.snapshots_dir.parent, self.snapshots_dir, self.tmp_dir):
            directory.mkdir(mode=0o755, exist_ok=True)
        for entry in self.tmp_dir.iterdir():
            _remove(entry)
        for entry in sorted(self.snapshots_dir.iterdir()):
            snapshot = self._read(entry)
            if snapshot is None:
                _remove(entry)
            else:
                self._prune_variants(entry, snapshot)
                self._snapshots[snapshot.key] = snapshot
        with self.lock:
            self._make_room(0, 0, protect=set())

    def _read(self, entry: Path) -> Snapshot | None:
        if entry.is_symlink() or not entry.is_dir() or KEY.fullmatch(entry.name) is None:
            return None
        try:
            data = json.loads((entry / "meta.json").read_text(encoding="utf-8"))
            snapshot = Snapshot.from_record(data, self.versions)
        except (OSError, ValueError, KeyError, TypeError):
            return None
        tree = entry / "tree"
        if snapshot.key != entry.name or tree.is_symlink() or not tree.is_dir():
            return None
        return snapshot

    def _prune_variants(self, entry: Path, snapshot: Snapshot) -> None:
        """Drop variants built by another semble, model or cache format, or missing on disk."""
        variants = entry / "variants"
        variants.mkdir(mode=0o755, exist_ok=True)
        for name, info in list(snapshot.variants.items()):
            current = all(info[item] == value for item, value in self.versions.items())
            if not current or not (variants / name).is_dir():
                del snapshot.variants[name]
        for found in variants.iterdir():
            if found.name not in snapshot.variants:
                _remove(found)
        snapshot.storage_bytes = disk_usage(entry / "tree") + disk_usage(variants)
        self.write_meta(snapshot)

    # Reading --------------------------------------------------------------------------------

    def get(self, key: str) -> Snapshot | None:
        """The snapshot with that key, if any."""
        with self.lock:
            return self._snapshots.get(key)

    def all(self) -> list[Snapshot]:
        """Every snapshot, by key."""
        with self.lock:
            return [self._snapshots[key] for key in sorted(self._snapshots)]

    def usage(self) -> tuple[int, int]:
        """(snapshots, storage bytes)."""
        with self.lock:
            return len(self._snapshots), sum(s.storage_bytes for s in self._snapshots.values())

    def path(self, key: str) -> Path:
        """The directory of a snapshot."""
        return self.snapshots_dir / key

    @contextmanager
    def using(self, keys: Iterable[str]) -> Iterator[list[Snapshot]]:
        """Hold snapshots in use (never evicted meanwhile); 404 snapshot_missing if one is not."""
        wanted = list(keys)
        with self.lock:
            snapshots = []
            for key in wanted:
                snapshot = self._snapshots.get(key)
                if snapshot is None:
                    raise snapshot_missing(key)
                snapshots.append(snapshot)
            self._in_use.update(wanted)
        try:
            yield snapshots
        finally:
            with self.lock:
                self._in_use.subtract(wanted)
                self._in_use += Counter()  # drops the zero counts

    # Writing --------------------------------------------------------------------------------

    def staging(self) -> Path:
        """A new `0755` directory under tmp/ for a build in progress."""
        staged = Path(tempfile.mkdtemp(dir=self.tmp_dir))
        staged.chmod(0o755)
        return staged

    def write_meta(self, snapshot: Snapshot, directory: Path | None = None) -> None:
        """Write `meta.json` atomically (`0644`), into `directory` or the snapshot's own."""
        target = (directory or self.path(snapshot.key)) / "meta.json"
        descriptor, temporary = tempfile.mkstemp(dir=self.tmp_dir, suffix=".json")
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(snapshot.record(), handle, separators=(",", ":"))
            os.fchmod(handle.fileno(), 0o644)
        os.replace(temporary, target)

    def install(self, staged: Path, snapshot: Snapshot) -> None:
        """Rename a staged snapshot into place, first evicting others until it fits."""
        with self.lock:
            if snapshot.cancelled.is_set():
                raise Abandoned
            self._make_room(snapshot.storage_bytes, 1, protect={snapshot.key})
            self.write_meta(snapshot, staged)
            staged.rename(self.path(snapshot.key))
            self._snapshots[snapshot.key] = snapshot

    def add_variant(self, snapshot: Snapshot, name: str, built: Path, info: dict[str, Any]) -> None:
        """Rename a variant built on demand into its snapshot, evicting others until it fits."""
        with self.lock:
            if self._snapshots.get(snapshot.key) is not snapshot:
                raise snapshot_missing(snapshot.key)
            self._make_room(info["storage_bytes"], 0, protect={snapshot.key})
            built.rename(self.path(snapshot.key) / "variants" / name)
            snapshot.variants[name] = info
            snapshot.storage_bytes += info["storage_bytes"]
            self.write_meta(snapshot)

    def touch(self, snapshots: Iterable[Snapshot]) -> None:
        """Record a use: `last_used_at` is now."""
        now = self.clock()
        with self.lock:
            for snapshot in snapshots:
                if self._snapshots.get(snapshot.key) is snapshot:
                    snapshot.last_used_at = now
                    self.write_meta(snapshot)

    def remove(self, key: str) -> bool:
        """Delete one snapshot (even one in use); False if there was none."""
        with self.lock:
            snapshot = self._snapshots.pop(key, None)
            if snapshot is None:
                return False
            snapshot.cancelled.set()
            trash = self.staging()
            self.path(key).rename(trash / "snapshot")
        self._on_evict(key)
        shutil.rmtree(trash)
        return True

    def _make_room(self, extra_bytes: int, extra_count: int, protect: set[str]) -> None:
        """Evict least-recently-used snapshots not in use until the caps hold with the extra.

        Evict nothing, and raise storage_full, if even evicting all of them would not do.
        """
        count, total = len(self._snapshots), sum(s.storage_bytes for s in self._snapshots.values())
        candidates = sorted(
            (
                s
                for s in self._snapshots.values()
                if s.key not in protect and not self._in_use[s.key]
            ),
            key=lambda s: (s.last_used_at, s.key),
        )
        least_count = count - len(candidates) + extra_count
        least_bytes = total - sum(s.storage_bytes for s in candidates) + extra_bytes
        if least_count > self.max_snapshots or least_bytes > self.max_storage_bytes:
            raise storage_full()
        for victim in candidates:
            if (
                count + extra_count <= self.max_snapshots
                and total + extra_bytes <= self.max_storage_bytes
            ):
                break
            self.remove(victim.key)
            count, total = count - 1, total - victim.storage_bytes
