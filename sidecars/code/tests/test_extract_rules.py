"""The extraction rules (ACT-106): selection, modes, the data filter, conflicts, damage."""

from __future__ import annotations

import errno
import gzip
import os
import tarfile
from pathlib import Path
from typing import Any

import pytest

from archives import MTIME, Member, archive, file, tar_bytes
from extraction import refused, run, written
from vaultgate_code import extract
from vaultgate_code.errors import ApiError
from vaultgate_code.extract import Abandoned, ArchiveError


def test_include_then_exclude_are_applied_before_writing(tmp_path: Path) -> None:
    """ACT-106: include then exclude (gitignore syntax) decide; an excluded file never exists."""
    members = [
        file("src/a.py", "a"),
        file("src/.env", "SECRET"),
        file("src/vendor/v.py", "v"),
        file("docs/d.md", "d"),
        file("keys/k.pem", "k"),
    ]
    tree, counts = run(
        tmp_path, archive(members), include=["src/", "keys/"], exclude=[".env", "*.pem", "vendor/"]
    )
    assert written(tree) == {"src/a.py": b"a"}
    assert counts.skipped["excluded"] == 4
    assert not (tree / "docs").exists()


def test_files_over_max_file_bytes_are_skipped(tmp_path: Path) -> None:
    """ACT-106, ACT-107: a file larger than max_file_bytes is not written and is counted."""
    members = [file("big.json", b"1" * ((1 << 16) + 1)), file("fits.json", b"1" * (1 << 16))]
    tree, counts = run(tmp_path, archive(members))
    assert list(written(tree)) == ["fits.json"]
    assert counts.skipped["large"] == 1
    assert (counts.files, counts.bytes) == (1, 1 << 16)


def test_modes_are_fixed_and_modification_times_kept(tmp_path: Path) -> None:
    """ACT-106: files are 0644 and directories 0755 whatever the archive says; times are kept."""
    tree, _ = run(tmp_path, archive([file("deep/er/x.sh", "#!/bin/sh\n")]))
    target = tree / "deep" / "er" / "x.sh"
    assert target.stat().st_mode & 0o7777 == 0o644
    assert (tree / "deep").stat().st_mode & 0o7777 == 0o755
    assert (tree / "deep" / "er").stat().st_mode & 0o7777 == 0o755
    assert target.stat().st_mtime == MTIME


def test_the_data_filter_is_applied_as_well(tmp_path: Path) -> None:
    """ACT-106: tarfile's data filter runs too, refusing a path a planted link would redirect."""
    (tmp_path / "tree").mkdir()
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "tree" / "planted").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(ArchiveError) as caught:
        run(tmp_path, archive([file("planted/x.py", "x")]))
    assert caught.value.code == "archive_invalid"
    assert "data filter" in caught.value.message
    assert not list((tmp_path / "elsewhere").iterdir())


def test_a_planted_link_is_never_followed_when_writing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-106: parent directories are opened with O_NOFOLLOW, even without the data filter."""
    (tmp_path / "tree").mkdir()
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "tree" / "planted").symlink_to(tmp_path / "elsewhere")
    monkeypatch.setattr(tarfile, "data_filter", lambda member, _dest: member)
    with pytest.raises(ArchiveError) as caught:
        run(tmp_path, archive([file("planted/x.py", "x")]))
    assert "conflicting" in caught.value.message
    assert not list((tmp_path / "elsewhere").iterdir())


@pytest.mark.parametrize(
    "members",
    [
        [file("a", "file"), file("a/b.py", "under a file")],
        [file("same.py", "one"), file("same.py", "two")],
    ],
)
def test_conflicting_entries_are_invalid(tmp_path: Path, members: list[Member]) -> None:
    """ACT-106: a file where a directory must go, or the same file twice, is archive_invalid."""
    assert "conflicting" in refused(tmp_path, archive(members), "archive_invalid").message


def test_a_full_disk_is_storage_full(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """ACT-106: running out of space while writing is 507 storage_full, not the archive's fault."""

    def full(*_arguments: object) -> None:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(extract, "_write_file", full)
    with pytest.raises(ApiError) as caught:
        run(tmp_path, archive([file("a.py", "a")]))
    assert (caught.value.status, caught.value.code) == (507, "storage_full")


@pytest.mark.parametrize(
    ("damage", "expected"),
    [
        (lambda _data: b"not gzip at all", "BadGzipFile"),
        (lambda _data: gzip.compress(b"x" * 4096), "ReadError"),
        (lambda data: data[: len(data) // 2], "EOFError"),
        (lambda data: data + b"trailing", "BadGzipFile"),
        (lambda data: data[:-8] + bytes(8), "BadGzipFile"),
    ],
)
def test_unreadable_archives_are_invalid(tmp_path: Path, damage: Any, expected: str) -> None:
    """ACT-106: bytes that are not a gzip tar, truncated or corrupt, are archive_invalid."""
    data = archive([file("random.bin", os.urandom(20_000))])
    assert expected in refused(tmp_path, damage(data), "archive_invalid").message


def test_data_after_the_end_of_the_archive_is_invalid(tmp_path: Path) -> None:
    """ACT-106: tarfile stops at a header it cannot parse; what follows must be padding only."""
    raw = tar_bytes([file("a.py", "a")]) + b"\x01" * 512 + bytes(1024)
    assert "after its end" in refused(tmp_path, gzip.compress(raw), "archive_invalid").message


def test_padding_after_the_end_of_the_archive_is_accepted(tmp_path: Path) -> None:
    """ACT-106: zero blocks after the end-of-archive marker are padding, read to the end."""
    raw = tar_bytes([file("a.py", "a = 1\n")]) + bytes(1 << 20)
    tree, _ = run(tmp_path, gzip.compress(raw))
    assert written(tree) == {"a.py": b"a = 1\n"}


def test_a_deleted_snapshot_abandons_its_extraction(tmp_path: Path) -> None:
    """ACT-106: a build whose snapshot is deleted stops at the next member."""
    with pytest.raises(Abandoned):
        run(tmp_path, archive([file("a.py", "a")]), cancelled=lambda: True)
