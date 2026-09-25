"""The hostile-archive suite (ACT-106, ACT-117): real gzip tars built here, every outcome asserted."""

from __future__ import annotations

import errno
import gzip
import io
import os
import tarfile
from pathlib import Path
from typing import Any

import pytest
from pathspec import GitIgnoreSpec

from archives import COMMIT, MTIME, TOP, Member, archive, directory, file, link, special, tar_bytes
from vaultgate_code import extract
from vaultgate_code.errors import ApiError
from vaultgate_code.extract import Abandoned, ArchiveError, Extractor, Limits

LIMITS = Limits(
    max_archive_bytes=1 << 20, max_files=100, max_total_bytes=1 << 20, max_file_bytes=1 << 16
)


def run(
    tmp_path: Path, data: bytes, limits: Limits = LIMITS, **options: Any
) -> tuple[Path, extract.Counts]:
    """Extract into tmp_path/tree; return the tree and the counts."""
    tree = tmp_path / "tree"
    tree.mkdir(exist_ok=True)
    include = options.get("include")
    extractor = Extractor(
        str(tree),
        limits,
        GitIgnoreSpec.from_lines(include) if include else None,
        GitIgnoreSpec.from_lines(options.get("exclude", [".env", "*.pem"])),
        options.get("cancelled", lambda: False),
    )
    return tree, extractor.run(io.BytesIO(data))


def refused(
    tmp_path: Path, data: bytes, code: str, limits: Limits = LIMITS, **options: Any
) -> ArchiveError:
    """Extract, expecting 422 `code`; assert nothing exists outside the tree."""
    with pytest.raises(ArchiveError) as caught:
        run(tmp_path, data, limits, **options)
    assert caught.value.status == 422
    assert caught.value.code == code
    assert sorted(p.name for p in tmp_path.iterdir()) == ["tree"]
    return caught.value


def written(tree: Path) -> dict[str, bytes]:
    """Every regular file under the tree, by relative path; asserts no link exists."""
    found = {}
    for path in tree.rglob("*"):
        assert not path.is_symlink()
        if path.is_file():
            found[path.relative_to(tree).as_posix()] = path.read_bytes()
    return found


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
    """ACT-106: files are 0644 and directories 0755 whatever the archive says; mtimes are kept."""
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
        (lambda data: b"not gzip at all", "BadGzipFile"),
        (lambda data: gzip.compress(b"x" * 4096), "ReadError"),
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


def test_a_deleted_snapshot_abandons_its_extraction(tmp_path: Path) -> None:
    """ACT-106: a build whose snapshot is deleted stops at the next member."""
    with pytest.raises(Abandoned):
        run(tmp_path, archive([file("a.py", "a")]), cancelled=lambda: True)
