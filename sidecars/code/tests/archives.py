"""Gzip tar archives built in the test, shaped like GitHub's tarballs, hostile ones included."""

from __future__ import annotations

import base64
import gzip
import io
import json
import tarfile
from dataclasses import dataclass
from typing import Any

TOP = "acme-widgets-0123456"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
DEFAULT_EXCLUDE = [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_ed25519*",
    "*.kdbx",
    ".git-credentials",
    ".netrc",
    ".npmrc",
]
MTIME = 1_700_000_000


@dataclass(frozen=True)
class Member:
    """One archive member; `name` is below the top-level directory unless `raw`."""

    name: str
    kind: bytes = tarfile.REGTYPE
    data: bytes = b""
    target: str = ""
    size: int | None = None  # a header size other than len(data)
    raw: bool = False


def file(name: str, data: bytes | str = b"", **options: Any) -> Member:
    """A regular file."""
    return Member(name, data=data.encode() if isinstance(data, str) else data, **options)


def directory(name: str, **options: Any) -> Member:
    """A directory."""
    return Member(name, kind=tarfile.DIRTYPE, **options)


def link(name: str, target: str, *, hard: bool = False) -> Member:
    """A symbolic or hard link."""
    return Member(name, kind=tarfile.LNKTYPE if hard else tarfile.SYMTYPE, target=target)


def special(name: str, kind: bytes) -> Member:
    """A character or block device, or a FIFO."""
    return Member(name, kind=kind)


def tar_bytes(members: list[Member], *, top: str | None = TOP, pax_global: bool = True) -> bytes:
    """The uncompressed tar. With `top`, a top-level directory member comes first."""
    buffer = io.BytesIO()
    headers = {"comment": COMMIT} if pax_global else {}
    with tarfile.open(
        fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT, pax_headers=headers
    ) as tar:
        if top is not None:
            tar.addfile(_info(Member(top, kind=tarfile.DIRTYPE, raw=True), top))
        for member in members:
            info = _info(member, top)
            tar.addfile(info, io.BytesIO(member.data) if member.kind == tarfile.REGTYPE else None)
    return buffer.getvalue()


def _info(member: Member, top: str | None) -> tarfile.TarInfo:
    name = member.name if member.raw or top is None else f"{top}/{member.name}"
    info = tarfile.TarInfo(name)
    info.type = member.kind
    info.mtime = MTIME
    info.mode = 0o777 if member.kind == tarfile.REGTYPE else 0o755
    info.linkname = member.target
    info.size = len(member.data) if member.size is None else member.size
    if member.kind != tarfile.REGTYPE:
        info.size = 0
    return info


def archive(members: list[Member], **options: Any) -> bytes:
    """The gzip tar."""
    return gzip.compress(tar_bytes(members, **options), mtime=0)


def spec(**overrides: Any) -> dict[str, Any]:
    """A build spec with the connector's defaults."""
    return {
        "owner": "target-1",
        "commit": COMMIT,
        "include": [],
        "exclude": list(DEFAULT_EXCLUDE),
        "max_archive_bytes": 256 << 20,
        "max_files": 50_000,
        "max_total_bytes": 1 << 30,
        "max_file_bytes": 1 << 20,
        "build_timeout_s": 600,
        "variants": [["code"]],
    } | overrides


def header(**overrides: Any) -> str:
    """The `X-Vaultgate-Build` header of `spec(**overrides)`."""
    raw = json.dumps(spec(**overrides)).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")
