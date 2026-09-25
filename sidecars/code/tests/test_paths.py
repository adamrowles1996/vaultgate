"""The path rules of ACT-111 against real snapshot directories."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from conftest import ServiceFactory, put
from vaultgate_code import query
from vaultgate_code.errors import ApiError
from vaultgate_code.service import Service


def read(service: Service, path: object, key: str = "acme", **extra: Any) -> dict[str, Any]:
    """POST /v1/read through the service."""
    return query.read(service, {"key": key, "file_path": path, "max_lines": 2000, **extra})


def code_of(call: Any) -> tuple[int, str]:
    """Run a call expecting an ApiError; (status, code)."""
    with pytest.raises(ApiError) as caught:
        call()
    return caught.value.status, caught.value.code


@pytest.fixture
def planted(make_service: ServiceFactory, tmp_path: Path) -> Service:
    """A snapshot whose tree gained links and a FIFO after extraction."""
    service = make_service()
    put(service, "acme", variants=[])
    tree = service.store.path("acme") / "tree"
    outside = tmp_path / "outside.txt"
    outside.write_text("outside the snapshot\n")
    (tree / "to-outside.txt").symlink_to(outside)
    (tree / "to-inside.md").symlink_to(tree / "README.md")
    (tree / "relative.md").symlink_to("README.md")
    (tree / "linked-dir").symlink_to(tree / "src")
    (tree / "escape-dir").symlink_to(tmp_path)
    os.mkfifo(tree / "pipe.txt")
    return service


@pytest.mark.parametrize(
    "path",
    [
        "/etc/passwd",
        "../outside.txt",
        "src/../README.md",
        "./README.md",
        "src//billing/invoice.py",
        "src/",
        "",
        "src\\billing\\invoice.py",
        "README.md\x00.txt",
        "a" * 1025,
        "\ud800.md",
    ],
)
def test_malformed_paths_are_invalid_path(shared: Service, path: str) -> None:
    """ACT-111: an absolute path, `..`, `.` or empty segment, backslash, NUL or over 1 024 bytes."""
    assert code_of(lambda: read(shared, path)) == (400, "invalid_path")


def test_a_path_that_is_not_a_string_is_invalid_request(shared: Service) -> None:
    """ACT-111: a path argument must be a string."""
    assert code_of(lambda: read(shared, 42)) == (400, "invalid_request")


def test_the_longest_valid_path_is_merely_not_found(shared: Service) -> None:
    """ACT-111: 1 024 bytes is allowed; a file that is absent is path_not_found."""
    assert code_of(lambda: read(shared, "a" * 200 + "/" + "b" * 823)) == (404, "path_not_found")


@pytest.mark.parametrize(
    "path",
    [
        ".env",
        "keys/deploy.pem",
        "data/huge.json",
        "src/alias.py",
        "src/copy.py",
        "missing.py",
        "src",
    ],
)
def test_skipped_excluded_and_absent_files_are_not_found(shared: Service, path: str) -> None:
    """ACT-111: excluded, skipped, linked, absent and non-file paths are all path_not_found."""
    assert code_of(lambda: read(shared, path)) == (404, "path_not_found")


def test_a_file_of_the_snapshot_is_read(shared: Service) -> None:
    """ACT-111: a regular file inside the snapshot is read."""
    assert read(shared, "src/billing/refund.py")["text"].startswith('"""Refunds')


@pytest.mark.parametrize(
    "path",
    [
        "to-outside.txt",
        "to-inside.md",
        "relative.md",
        "linked-dir/billing/invoice.py",
        "escape-dir/outside.txt",
        "pipe.txt",
    ],
)
def test_links_and_fifos_planted_after_extraction_are_not_followed(
    planted: Service, path: str
) -> None:
    """ACT-111: a link or FIFO planted in the tree after extraction is refused, never followed."""
    assert code_of(lambda: read(planted, path)) == (404, "path_not_found")
    assert read(planted, "README.md")["text"].startswith("# Acme")


def test_a_path_below_a_file_is_not_found(shared: Service) -> None:
    """ACT-111: a path through a file is path_not_found."""
    assert code_of(lambda: read(shared, "README.md/x")) == (404, "path_not_found")


def test_search_paths_and_related_paths_obey_the_rules(shared: Service) -> None:
    """ACT-111: search `paths` and the related `file_path` follow the same rules."""
    base = {
        "indexes": [{"key": "acme", "label": "acme"}],
        "content": ["code"],
        "top_k": 3,
        "max_snippet_lines": 0,
    }
    bad_search = {**base, "query": "invoice", "paths": ["../x.py"]}
    assert code_of(lambda: query.search(shared, bad_search)) == (400, "invalid_path")
    bad_related = {**base, "file_path": "/abs.py", "line": 1}
    assert code_of(lambda: query.related(shared, bad_related)) == (400, "invalid_path")
