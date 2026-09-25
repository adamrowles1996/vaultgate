"""A snapshot's metadata, as `meta.json` holds it and as the protocol shows it."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SKIPPED = ("links", "special", "excluded", "large")
VARIANT_PUBLIC = ("files", "chunks", "built_at", "duration_ms", "storage_bytes")


def _int(data: dict[str, Any], name: str) -> int:
    value = data[name]
    if type(value) is not int or value < 0:
        raise TypeError(name)
    return value


def _str(data: dict[str, Any], name: str) -> str:
    value = data[name]
    if type(value) is not str:
        raise TypeError(name)
    return value


def _mapping(data: dict[str, Any], name: str) -> dict[str, Any]:
    value = data[name]
    if type(value) is not dict:
        raise TypeError(name)
    return value


@dataclass
class Snapshot:
    """One extracted commit and the variants built over it."""

    key: str
    owner: str
    commit: str
    created_at: int
    last_used_at: int
    files: int
    bytes: int
    skipped: dict[str, int]
    storage_bytes: int
    build_timeout_s: int
    variants: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Set when the snapshot is deleted or evicted: a build still running for it stops.
    cancelled: threading.Event = field(default_factory=threading.Event, compare=False)

    def public(self) -> dict[str, Any]:
        """The metadata the protocol returns."""
        return {
            "key": self.key,
            "owner": self.owner,
            "commit": self.commit,
            "created_at": self.created_at,
            "last_used_at": self.last_used_at,
            "files": self.files,
            "bytes": self.bytes,
            "skipped": dict(self.skipped),
            "storage_bytes": self.storage_bytes,
            "variants": {
                name: {item: info[item] for item in VARIANT_PUBLIC}
                for name, info in sorted(self.variants.items())
            },
        }

    def record(self) -> dict[str, Any]:
        """What `meta.json` holds.

        That is the public metadata, the build timeout and each variant's `semble`, model and
        cache-format versions.
        """
        record = self.public()
        record["build_timeout_s"] = self.build_timeout_s
        record["variants"] = {name: dict(info) for name, info in self.variants.items()}
        return record

    @classmethod
    def from_record(cls, data: object, versions: dict[str, Any]) -> Snapshot:
        """Rebuild from `meta.json`, strictly; raises TypeError, KeyError or ValueError."""
        if type(data) is not dict:
            raise TypeError("meta")
        skipped = _mapping(data, "skipped")
        variants = _mapping(data, "variants")
        for info in variants.values():
            if type(info) is not dict:
                raise TypeError("variant")
            for name in VARIANT_PUBLIC:
                _int(info, name)
            missing = [name for name in versions if name not in info]
            if missing:
                raise KeyError(missing[0])
        return cls(
            key=_str(data, "key"),
            owner=_str(data, "owner"),
            commit=_str(data, "commit"),
            created_at=_int(data, "created_at"),
            last_used_at=_int(data, "last_used_at"),
            files=_int(data, "files"),
            bytes=_int(data, "bytes"),
            skipped={name: _int(skipped, name) for name in SKIPPED},
            storage_bytes=_int(data, "storage_bytes"),
            build_timeout_s=_int(data, "build_timeout_s"),
            variants=variants,
        )


def disk_usage(path: Path) -> int:
    """The apparent size of every regular file below `path`, never following a link."""
    total = 0
    for directory, _, names in os.walk(path):
        for name in names:
            status = os.lstat(os.path.join(directory, name))
            total += status.st_size
    return total
