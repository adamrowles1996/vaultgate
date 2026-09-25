"""The operations health, build, status, list and delete, over the store and the build runner."""

from __future__ import annotations

import platform
import shutil
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from vaultgate_code import PROTOCOL_VERSION, child, engine, rules, validate
from vaultgate_code.builder import Flights, Runner
from vaultgate_code.config import Config
from vaultgate_code.errors import ApiError
from vaultgate_code.extract import Abandoned, Counts, Extractor, Readable
from vaultgate_code.fetch_model import Manifest
from vaultgate_code.memory import Loaded, load_trim
from vaultgate_code.snapshot import Snapshot, disk_usage
from vaultgate_code.store import Store


def now_ms() -> int:
    """Milliseconds since the epoch."""
    return time.time_ns() // 1_000_000


def abandoned(key: str) -> ApiError:
    """404: the snapshot was deleted while it was being built."""
    return ApiError(
        404, "snapshot_missing", "the snapshot was deleted during its build", {"key": key}
    )


@dataclass(frozen=True)
class _Building:
    owner: str
    started_at: int
    cancel: threading.Event


class Service:
    """Every operation of PROTOCOL.md except the queries (`query`, which use `indexes`)."""

    def __init__(
        self,
        config: Config,
        manifest: Manifest,
        clock: Callable[[], int] = now_ms,
        trim: Callable[[], None] | None = None,
    ) -> None:
        """Wire the store, the loaded-index cache and the build runner."""
        self.config = config
        self.manifest = manifest
        self.clock = clock
        self.versions = {
            **engine.VERSIONS,
            "model": manifest.model,
            "model_revision": manifest.revision,
        }
        self.loaded = Loaded(config.max_memory_bytes, trim or load_trim())
        self.store = Store(
            config.state,
            config.max_snapshots,
            config.max_storage_bytes,
            self.versions,
            self.loaded.drop_key,
            clock,
        )
        self.runner = Runner(str(config.model), config.build_concurrency, child.main)
        self.flights = Flights()
        self._lock = threading.Lock()
        self._building: dict[str, _Building] = {}
        self._active = 0

    # health, list, status -------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """`GET /v1/health`."""
        snapshots, storage = self.store.usage()
        variants, loaded_bytes = self.loaded.usage()
        config = self.config
        return {
            "protocol": PROTOCOL_VERSION,
            "semble": engine.SEMBLE_VERSION,
            "model": self.manifest.model,
            "model_revision": self.manifest.revision,
            "python": platform.python_version(),
            "limits": {
                "max_snapshots": config.max_snapshots,
                "max_storage_bytes": config.max_storage_bytes,
                "max_memory_bytes": config.max_memory_bytes,
                "build_concurrency": config.build_concurrency,
            },
            "usage": {
                "snapshots": snapshots,
                "storage_bytes": storage,
                "loaded_variants": variants,
                "loaded_bytes": loaded_bytes,
                "building": self._active,
            },
        }

    def list_snapshots(self) -> dict[str, Any]:
        """`GET /v1/snapshots`."""
        with self._lock:
            building = [
                {"key": key, "owner": state.owner, "started_at": state.started_at}
                for key, state in sorted(self._building.items())
            ]
        return {"snapshots": [s.public() for s in self.store.all()], "building": building}

    def status(self, key: str) -> tuple[int, dict[str, Any]]:
        """`GET /v1/snapshots/{key}`: 200 metadata, 202 while building, else 404."""
        rules.identifier(key, rules.KEY, "key")
        snapshot = self.store.get(key)
        if snapshot is not None:
            return 200, snapshot.public()
        with self._lock:
            state = self._building.get(key)
        if state is None:
            raise ApiError(404, "snapshot_missing", "no snapshot has that key", {"key": key})
        return 202, {"state": "building", "started_at": state.started_at}

    # delete ---------------------------------------------------------------------------------

    def delete(self, key: str) -> dict[str, int]:
        """`DELETE /v1/snapshots/{key}`: the snapshot, and any build of it, abandoned."""
        rules.identifier(key, rules.KEY, "key")
        return {"deleted": self._delete([key])}

    def delete_owner(self, owner: str) -> dict[str, int]:
        """`DELETE /v1/owners/{owner}`: every snapshot and build of a target."""
        rules.identifier(owner, rules.OWNER, "owner")
        keys = {s.key for s in self.store.all() if s.owner == owner}
        with self._lock:
            keys |= {key for key, state in self._building.items() if state.owner == owner}
        return {"deleted": self._delete(sorted(keys))}

    def _delete(self, keys: Sequence[str]) -> int:
        deleted = 0
        for key in keys:
            with self._lock:
                state = self._building.pop(key, None)
            if state is not None:
                state.cancel.set()
                self.flights.forget(("snapshot", key))
            deleted += int(self.store.remove(key) or state is not None)
        return deleted

    # build ----------------------------------------------------------------------------------

    def put(self, key: str, header: str | None, body: Readable) -> dict[str, Any]:
        """`PUT /v1/snapshots/{key}`: build, or answer an existing or running build."""
        rules.identifier(key, rules.KEY, "key")
        spec = validate.build_spec(header)
        result: dict[str, Any] = self.flights.run(
            ("snapshot", key), lambda: self._build_snapshot(key, spec, body)
        )
        return result

    def _build_snapshot(self, key: str, spec: validate.BuildSpec, body: Readable) -> dict[str, Any]:
        existing = self.store.get(key)
        if existing is not None:
            return existing.public()
        state = _Building(spec.owner, self.clock(), threading.Event())
        with self._lock:
            self._building[key] = state
            self._active += 1
        staged = self.store.staging()
        try:
            return self._assemble(key, spec, body, staged, state.cancel)
        except Abandoned:
            raise abandoned(key) from None
        finally:
            shutil.rmtree(staged, ignore_errors=True)
            with self._lock:
                self._active -= 1
                if self._building.get(key) is state:
                    del self._building[key]

    @contextmanager
    def building(self) -> Iterator[None]:
        """Count a variant build that is not a snapshot's own in health's `usage.building`."""
        with self._lock:
            self._active += 1
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1

    def _assemble(
        self,
        key: str,
        spec: validate.BuildSpec,
        body: Readable,
        staged: Path,
        cancel: threading.Event,
    ) -> dict[str, Any]:
        tree, variants = staged / "tree", staged / "variants"
        for directory in (tree, variants):
            directory.mkdir()
            directory.chmod(0o755)
        counts = Extractor(str(tree), spec.limits, spec.include, spec.exclude, cancel.is_set).run(
            body
        )
        snapshot = Snapshot(
            key,
            spec.owner,
            spec.commit,
            0,
            0,
            counts.files,
            counts.bytes,
            dict(counts.skipped),
            0,
            spec.build_timeout_s,
            cancelled=cancel,
        )
        for content in spec.variants:
            name = rules.variant_name(content)
            snapshot.variants[name] = self.build_variant(
                tree, variants / name, content, spec.build_timeout_s, cancel, counts
            )
        snapshot.storage_bytes = disk_usage(tree) + disk_usage(variants)
        snapshot.created_at = snapshot.last_used_at = self.clock()
        self.store.install(staged, snapshot)
        return snapshot.public()

    def build_variant(
        self,
        tree: Path,
        out: Path,
        content: tuple[str, ...],
        timeout_s: int,
        cancel: threading.Event,
        counts: Counts | None,
    ) -> dict[str, Any]:
        """Build one variant into `out` in the build child; its metadata, versions included.

        A build error gains the variant's name, and the extraction's counts when there are any.
        """
        try:
            files, chunks, duration_ms = self.runner.build(
                str(tree), str(out), content, timeout_s, cancel
            )
        except ApiError as error:
            detail = {**(counts.detail() if counts else {}), "variant": rules.variant_name(content)}
            raise ApiError(error.status, error.code, error.message, detail) from None
        return {
            "files": files,
            "chunks": chunks,
            "built_at": self.clock(),
            "duration_ms": duration_ms,
            "storage_bytes": disk_usage(out),
            **self.versions,
        }
