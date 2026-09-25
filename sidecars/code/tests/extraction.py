"""Running the extractor directly over an archive built in the test, into `tmp_path/tree`."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest
from pathspec import GitIgnoreSpec

from vaultgate_code import extract
from vaultgate_code.extract import ArchiveError, Extractor, Limits

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
