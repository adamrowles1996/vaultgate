"""Streamed, hostile-archive-safe extraction of a forge's gzip tar (ACT-106, PROTOCOL.md).

The archive is read once, as it arrives. Compressed and decompressed bytes are counted through
capped readers, so a decompression bomb stops at `max_total_bytes + 64 MiB`. Each member is
judged by the rules below before `tarfile`'s own data filter sees it, and only regular files
are written: through directory descriptors opened with `O_NOFOLLOW`, created exclusively,
`0644` whatever the archive says, keeping the archive's modification time.
"""

from __future__ import annotations

import errno
import gzip
import os
import shutil
import tarfile
import zlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import IO, Any, Protocol, cast

from pathspec import GitIgnoreSpec

from vaultgate_code.errors import ApiError, storage_full
from vaultgate_code.rules import MAX_PATH_BYTES, path_problem

SLACK_BYTES = 64 << 20
COPY_BYTES = 1 << 20
MAX_MTIME = 2**33
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC


class Readable(Protocol):
    """Anything with `read(n)`: the request body, a file, a decompressor."""

    def read(self, size: int = -1, /) -> bytes:
        """Return at most `size` bytes; empty at the end."""
        ...


@dataclass(frozen=True)
class Limits:
    """The caps of one build."""

    max_archive_bytes: int
    max_files: int
    max_total_bytes: int
    max_file_bytes: int


@dataclass
class Counts:
    """What the extraction has seen so far."""

    members: int = 0
    files: int = 0
    bytes: int = 0
    skipped: dict[str, int] = field(
        default_factory=lambda: {"links": 0, "special": 0, "excluded": 0, "large": 0}
    )

    def detail(self) -> dict[str, Any]:
        """The counts as the `detail` of an error."""
        return {
            "members": self.members,
            "files": self.files,
            "bytes": self.bytes,
            "skipped": dict(self.skipped),
        }


class Abandoned(Exception):  # noqa: N818 - a state, not a fault
    """The snapshot was deleted while it was being built."""


class ArchiveError(ApiError):
    """422 with the counts so far."""

    def __init__(self, code: str, message: str, counts: Counts) -> None:
        """Record the reason and the counts."""
        super().__init__(422, code, message, counts.detail())


class CappedReader:
    """Count the bytes read through it; more than `cap` is `archive_too_large`."""

    def __init__(self, source: Readable, cap: int, what: str, counts: Counts) -> None:
        """Wrap `source`."""
        self._source = source
        self._cap = cap
        self._what = what
        self._counts = counts
        self.total = 0

    def read(self, size: int = -1, /) -> bytes:
        """Read and count."""
        chunk = self._source.read(size)
        self.total += len(chunk)
        if self.total > self._cap:
            raise ArchiveError(
                "archive_too_large",
                f"the {self._what} archive exceeds {self._cap} bytes",
                self._counts,
            )
        return chunk


class Extractor:
    """Extract one archive into `tree`, which must exist and be empty."""

    def __init__(
        self,
        tree: str,
        limits: Limits,
        include: GitIgnoreSpec | None,
        exclude: GitIgnoreSpec,
        cancelled: Callable[[], bool],
    ) -> None:
        """Prepare the rules of one build."""
        self._tree = tree
        self._limits = limits
        self._include = include
        self._exclude = exclude
        self._cancelled = cancelled
        self._top: str | None = None
        self.counts = Counts()

    def _invalid(self, message: str) -> ArchiveError:
        return ArchiveError("archive_invalid", message, self.counts)

    def _too_large(self, message: str) -> ArchiveError:
        return ArchiveError("archive_too_large", message, self.counts)

    def run(self, body: Readable) -> Counts:
        """Read the whole body, extracting as it goes; raise ArchiveError on any rule."""
        limits = self._limits
        compressed = CappedReader(body, limits.max_archive_bytes, "compressed", self.counts)
        try:
            with gzip.GzipFile(fileobj=compressed, mode="rb") as unzipped:  # type: ignore[call-overload]
                plain = CappedReader(
                    unzipped, limits.max_total_bytes + SLACK_BYTES, "decompressed", self.counts
                )
                with tarfile.open(fileobj=plain, mode="r|") as tar:  # type: ignore[call-overload]
                    for member in tar:
                        self._member(tar, member)
                # Read to the end, so the gzip trailer is checked and nothing is left unread.
                # tarfile stops at the first header it cannot parse: only padding may follow.
                while chunk := plain.read(COPY_BYTES):
                    if chunk.strip(b"\x00"):
                        raise self._invalid("the archive has data after its end")
        except (tarfile.TarError, EOFError, zlib.error, gzip.BadGzipFile) as error:
            raise self._invalid(f"the archive cannot be read ({type(error).__name__})") from None
        if self._top is None:
            raise self._invalid("the archive has no top-level directory")
        return self.counts

    def _member(self, tar: tarfile.TarFile, member: tarfile.TarInfo) -> None:
        counts = self.counts
        counts.members += 1
        if counts.members > 2 * self._limits.max_files + 1000:
            raise self._too_large("the archive has too many members")
        if self._cancelled():
            raise Abandoned
        relative = self._strip(member)
        if relative is None or member.isdir():
            return
        if member.issym() or member.islnk():
            counts.skipped["links"] += 1
        elif not member.isreg():
            counts.skipped["special"] += 1
        elif not self._selected(relative):
            counts.skipped["excluded"] += 1
        elif member.size > self._limits.max_file_bytes:
            counts.skipped["large"] += 1
        else:
            self._write(tar, member, relative)

    def _strip(self, member: tarfile.TarInfo) -> str | None:
        """Check the name and strip the one top-level directory; None for that directory."""
        problem = path_problem(member.name, max_bytes=None)
        if problem is not None:
            raise self._invalid(f"a member name {problem}")
        top, _, relative = member.name.partition("/")
        if self._top is None:
            self._top = top
        elif top != self._top:
            raise self._invalid("the archive has more than one top-level directory")
        if not relative:
            if not member.isdir():
                raise self._invalid("the archive has an entry outside its top-level directory")
            return None
        if len(relative.encode("utf-8")) > MAX_PATH_BYTES:
            raise self._invalid(f"a member name is longer than {MAX_PATH_BYTES} bytes")
        return relative

    def _selected(self, relative: str) -> bool:
        if self._include is not None and not self._include.match_file(relative):
            return False
        return not self._exclude.match_file(relative)

    def _write(self, tar: tarfile.TarFile, member: tarfile.TarInfo, relative: str) -> None:
        counts, limits = self.counts, self._limits
        if counts.files + 1 > limits.max_files:
            raise self._too_large(f"the archive has more than {limits.max_files} files")
        if counts.bytes + member.size > limits.max_total_bytes:
            raise self._too_large(f"the archive holds more than {limits.max_total_bytes} bytes")
        try:
            tarfile.data_filter(member.replace(name=relative, deep=False), self._tree)
        except tarfile.FilterError as error:
            raise self._invalid(
                f"the data filter refused a member ({type(error).__name__})"
            ) from None
        except OSError:  # its realpath() met a file where a directory must be
            raise self._invalid("the archive has conflicting entries") from None
        # extractfile() gives None only for members that are not regular files.
        source = cast("IO[bytes]", tar.extractfile(member))
        try:
            _write_file(self._tree, relative, source, member.mtime)
        except OSError as error:
            if error.errno in {errno.ENOSPC, errno.EDQUOT}:
                raise storage_full() from None
            raise self._invalid("the archive has conflicting entries") from None
        counts.files += 1
        counts.bytes += member.size


def _open_parent(tree: str, relative: str) -> tuple[int, str]:
    """Open (creating `0755` as needed) the parent directory of `relative`, never via a link."""
    *parents, name = relative.split("/")
    directory = os.open(tree, DIRECTORY_FLAGS)
    try:
        for segment in parents:
            created = True
            try:
                os.mkdir(segment, 0o755, dir_fd=directory)
            except FileExistsError:
                created = False
            child = os.open(segment, DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
            if created:
                os.fchmod(directory, 0o755)
    except BaseException:
        os.close(directory)
        raise
    return directory, name


def _write_file(tree: str, relative: str, source: IO[bytes], mtime: float) -> None:
    """Create one file exclusively, `0644`, with the archive's modification time."""
    directory, name = _open_parent(tree, relative)
    try:
        descriptor = os.open(name, FILE_FLAGS, 0o644, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(descriptor, "wb") as sink:
        shutil.copyfileobj(source, sink, COPY_BYTES)
        sink.flush()
        os.fchmod(descriptor, 0o644)
        kept = min(max(float(mtime), 0.0), MAX_MTIME)
        os.utime(descriptor, (kept, kept))
