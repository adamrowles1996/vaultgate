"""Reading files: ranges, truncation, text detection and the empty file (ACT-110, ACT-111)."""

from __future__ import annotations

from typing import Any

import pytest

from vaultgate_code import query
from vaultgate_code.errors import ApiError
from vaultgate_code.service import Service


def read(service: Service, path: str, **body: Any) -> dict[str, Any]:
    """POST /v1/read through the service."""
    return query.read(service, {"key": "acme", "file_path": path, "max_lines": 2000} | body)


def test_a_whole_file_by_default(shared: Service) -> None:
    """ACT-110: without a range, the whole file from line 1."""
    answer = read(shared, "notes/lines.txt")
    assert answer == {
        "file_path": "notes/lines.txt",
        "start_line": 1,
        "end_line": 50,
        "total_lines": 50,
        "text": "\n".join(f"line {n}" for n in range(1, 51)),
        "truncated": False,
    }


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"start_line": 10, "end_line": 12}, (10, 12, "line 10\nline 11\nline 12", False)),
        ({"start_line": 48}, (48, 50, "line 48\nline 49\nline 50", False)),
        ({"start_line": 49, "end_line": 400}, (49, 50, "line 49\nline 50", False)),
        ({"start_line": 5, "max_lines": 2}, (5, 6, "line 5\nline 6", True)),
        ({"start_line": 5, "end_line": 6, "max_lines": 2}, (5, 6, "line 5\nline 6", False)),
        ({"start_line": 5, "end_line": 7, "max_lines": 2}, (5, 6, "line 5\nline 6", True)),
        ({"start_line": 50, "end_line": 50}, (50, 50, "line 50", False)),
    ],
)
def test_ranges_and_truncation(
    shared: Service, body: dict[str, Any], expected: tuple[Any, ...]
) -> None:
    """ACT-110: the range is start to min(end, total, start + max_lines - 1); truncated says so."""
    answer = read(shared, "notes/lines.txt", **body)
    assert (
        answer["start_line"],
        answer["end_line"],
        answer["text"],
        answer["truncated"],
    ) == expected
    assert answer["total_lines"] == 50


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"start_line": 51}, "invalid_range"),
        ({"start_line": 5, "end_line": 4}, "invalid_range"),
        ({"max_lines": 2001}, "invalid_request"),
        ({"max_lines": 0}, "invalid_request"),
        ({"start_line": 0}, "invalid_request"),
    ],
)
def test_bad_ranges(shared: Service, body: dict[str, Any], code: str) -> None:
    """ACT-110: a start beyond the file or an end before the start is 400 invalid_range."""
    with pytest.raises(ApiError) as caught:
        read(shared, "notes/lines.txt", **body)
    assert (caught.value.status, caught.value.code) == (400, code)


def test_the_empty_file(shared: Service) -> None:
    """ACT-110: an empty file answers start_line 1, end_line 0 and no text."""
    assert read(shared, "empty.py") == {
        "file_path": "empty.py",
        "start_line": 1,
        "end_line": 0,
        "total_lines": 0,
        "text": "",
        "truncated": False,
    }
    with pytest.raises(ApiError) as caught:
        read(shared, "empty.py", start_line=2)
    assert caught.value.code == "invalid_range"


def test_a_file_with_a_nul_is_not_text(shared: Service) -> None:
    """ACT-111: a NUL in the first 8 KiB is 422 not_text."""
    with pytest.raises(ApiError) as caught:
        read(shared, "assets/logo.png")
    assert (caught.value.status, caught.value.code) == (422, "not_text")


def test_line_endings_and_bad_utf8(shared: Service) -> None:
    """ACT-110: lines split as str.splitlines() does; bad UTF-8 becomes replacement characters."""
    assert read(shared, "notes/crlf.txt")["text"] == "one\ntwo\nthree"
    assert read(shared, "notes/latin1.txt")["text"] == "caf�"
