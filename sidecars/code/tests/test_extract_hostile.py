"""The hostile-archive suite (ACT-106, ACT-117): links, devices, names, caps and structure."""

from __future__ import annotations

import gzip
import io
import os
import tarfile
from pathlib import Path

import pytest

from archives import COMMIT, TOP, archive, directory, file, link, special, tar_bytes
from extraction import refused, run, written
from vaultgate_code.extract import Limits


def test_links_are_skipped_and_counted(tmp_path: Path) -> None:
    """ACT-106: symbolic and hard links are skipped and counted, never created."""
    members = [
        file("a.py", "x = 1\n"),
        link("abs", "/etc/passwd"),
        link("up", "../../outside"),
        link("inner", "a.py"),
        link("hard", f"{TOP}/a.py", hard=True),
    ]
    tree, counts = run(tmp_path, archive(members))
    assert written(tree) == {"a.py": b"x = 1\n"}
    assert counts.skipped == {"links": 4, "special": 0, "excluded": 0, "large": 0}
    assert sorted(p.name for p in tmp_path.iterdir()) == ["tree"]


@pytest.mark.parametrize("kind", [tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, b"Z"])
def test_devices_fifos_and_unknown_types_are_skipped(tmp_path: Path, kind: bytes) -> None:
    """ACT-106: character and block devices, FIFOs and unknown types are skipped and counted."""
    tree, counts = run(tmp_path, archive([special("dev", kind), file("b.md", "# b\n")]))
    assert written(tree) == {"b.md": b"# b\n"}
    assert counts.skipped["special"] == 1
    assert not (tree / "dev").exists()


@pytest.mark.parametrize(
    ("name", "reason"),
    [
        ("/etc/passwd", "is absolute"),
        (f"{TOP}/../../evil.py", "segment"),
        (f"{TOP}/src/../../evil.py", "segment"),
        ("..", "segment"),
        (f"{TOP}/a\\b.py", "backslash"),
        (f"{TOP}/./a.py", "segment"),
        (f"{TOP}//a.py", "segment"),
    ],
)
def test_escaping_names_are_invalid(tmp_path: Path, name: str, reason: str) -> None:
    """ACT-106: an absolute name, a `..` segment or a backslash is archive_invalid."""
    error = refused(tmp_path, archive([file(name, "evil", raw=True)]), "archive_invalid")
    assert reason in error.message
    assert not list((tmp_path / "tree").iterdir())


def test_a_nul_in_a_name_is_invalid(tmp_path: Path) -> None:
    """ACT-106: a NUL in a member name (a pax path) is archive_invalid."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
        info = tarfile.TarInfo(f"{TOP}/a.py")
        info.pax_headers = {"path": f"{TOP}/a\x00.py"}
        tar.addfile(info, io.BytesIO(b""))
    error = refused(tmp_path, gzip.compress(buffer.getvalue()), "archive_invalid")
    assert "NUL" in error.message


def test_a_name_that_is_not_utf8_is_invalid(tmp_path: Path) -> None:
    """ACT-106: a member name that is not UTF-8 is archive_invalid."""
    buffer = io.BytesIO()
    with tarfile.open(
        fileobj=buffer, mode="w", format=tarfile.GNU_FORMAT, encoding="latin-1"
    ) as tar:
        tar.addfile(tarfile.TarInfo(f"{TOP}/caf\xe9.py"), io.BytesIO(b""))
    assert "UTF-8" in refused(tmp_path, gzip.compress(buffer.getvalue()), "archive_invalid").message


def test_names_longer_than_1024_bytes_are_invalid(tmp_path: Path) -> None:
    """ACT-106: a name longer than 1 024 bytes after stripping is archive_invalid; 1 024 is not."""
    at_limit = "/".join(["a" * 200] * 5 + ["b" * 19])
    assert len(at_limit.encode()) == 1024
    tree, _ = run(tmp_path, archive([file(at_limit, "ok")]))
    assert written(tree) == {at_limit: b"ok"}
    (tmp_path / "second").mkdir()
    error = refused(tmp_path / "second", archive([file(at_limit + "c", "no")]), "archive_invalid")
    assert "1024 bytes" in error.message


def test_a_decompression_bomb_stops_at_the_cap(tmp_path: Path) -> None:
    """ACT-106, ACT-117: decompressed bytes, skipped members included, stop at total + 64 MiB."""
    bomb = file("bomb.bin", bytes(80 << 20))
    data = archive([bomb])
    assert len(data) < 1 << 20  # well under the compressed cap
    error = refused(tmp_path, data, "archive_too_large")
    assert "decompressed" in error.message
    assert error.detail is not None
    assert error.detail["skipped"]["large"] == 1
    assert not list((tmp_path / "tree").iterdir())


def test_an_oversize_archive_stops_at_the_compressed_cap(tmp_path: Path) -> None:
    """ACT-106, ACT-117: more compressed bytes than max_archive_bytes is archive_too_large."""
    data = archive([file("random.bin", os.urandom(4096))])
    limits = Limits(
        max_archive_bytes=2048, max_files=100, max_total_bytes=1 << 20, max_file_bytes=1 << 16
    )
    assert "compressed" in refused(tmp_path, data, "archive_too_large", limits).message


def test_an_oversize_total_is_too_large(tmp_path: Path) -> None:
    """ACT-106, ACT-117: more written bytes than max_total_bytes is archive_too_large."""
    limits = Limits(
        max_archive_bytes=1 << 20, max_files=100, max_total_bytes=1500, max_file_bytes=1000
    )
    members = [file("one.txt", b"1" * 800), file("two.txt", b"2" * 800)]
    error = refused(tmp_path, archive(members), "archive_too_large", limits)
    assert error.detail == {
        "members": 3,
        "files": 1,
        "bytes": 800,
        "skipped": {"links": 0, "special": 0, "excluded": 0, "large": 0},
    }


def test_more_files_than_allowed_is_too_large(tmp_path: Path) -> None:
    """ACT-106, ACT-117: more written files than max_files is archive_too_large."""
    limits = Limits(
        max_archive_bytes=1 << 20, max_files=2, max_total_bytes=1 << 20, max_file_bytes=1000
    )
    members = [file(f"{n}.txt", "x") for n in range(3)]
    assert (
        "more than 2 files"
        in refused(tmp_path, archive(members), "archive_too_large", limits).message
    )


def test_too_many_members_is_too_large(tmp_path: Path) -> None:
    """ACT-106, ACT-117: more members than 2 x max_files + 1000, skipped ones included."""
    limits = Limits(
        max_archive_bytes=1 << 20, max_files=1, max_total_bytes=1 << 20, max_file_bytes=1000
    )
    at_cap = [directory(f"d{n}") for n in range(1001)]  # with the top directory: 1002 members
    _, counts = run(tmp_path, archive(at_cap), limits)
    assert counts.members == 1002
    (tmp_path / "over").mkdir()
    error = refused(
        tmp_path / "over", archive([*at_cap, link("one-more", "x")]), "archive_too_large", limits
    )
    assert "too many members" in error.message


def test_a_missing_top_level_directory_is_invalid(tmp_path: Path) -> None:
    """ACT-106, ACT-117: files at the root, with no top-level directory, are archive_invalid."""
    data = archive([file("README.md", "# hi\n")], top=None)
    assert "outside its top-level" in refused(tmp_path, data, "archive_invalid").message


def test_an_archive_without_members_has_no_top_level_directory(tmp_path: Path) -> None:
    """ACT-106: an archive of nothing but end-of-archive blocks is archive_invalid."""
    data = gzip.compress(bytes(10240))
    assert "no top-level" in refused(tmp_path, data, "archive_invalid").message


def test_two_top_level_directories_are_invalid(tmp_path: Path) -> None:
    """ACT-106, ACT-117: two top-level directories are archive_invalid."""
    members = [file("a.py", "a"), file("other-repo/b.py", "b", raw=True)]
    assert (
        "more than one top-level" in refused(tmp_path, archive(members), "archive_invalid").message
    )


def test_a_top_level_file_is_invalid(tmp_path: Path) -> None:
    """ACT-106: a top-level entry that is not a directory is archive_invalid."""
    data = archive([file(TOP, "not a directory", raw=True)], top=None)
    assert "outside its top-level" in refused(tmp_path, data, "archive_invalid").message


def test_a_pax_global_header_is_not_a_member(tmp_path: Path) -> None:
    """ACT-106: GitHub's pax global header (the commit id) is neither a member nor a file."""
    raw = tar_bytes([file("a.py", "a = 1\n")], pax_global=True)
    assert COMMIT.encode() in raw[:1024]
    tree, counts = run(tmp_path, gzip.compress(raw))
    assert counts.members == 2  # the top-level directory and a.py
    assert written(tree) == {"a.py": b"a = 1\n"}
