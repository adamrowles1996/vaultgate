"""Request validation: the JSON bodies and the build spec header. Unknown fields are refused."""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pathspec import GitIgnoreSpec

from vaultgate_code import rules
from vaultgate_code.errors import ApiError, invalid_request
from vaultgate_code.extract import Limits

Check = Callable[[str, object], Any]
MAX_LINE = 2**31 - 1
GIB = 1 << 30
MAX_PATTERNS = 100
MAX_PATTERN_CHARS = 1024
BASE64URL = re.compile(r"[A-Za-z0-9_-]*")


def parse_json(raw: bytes) -> object:
    """Decode a UTF-8 JSON document, or 400 invalid_request."""
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise invalid_request("the body is not UTF-8 JSON") from None


def fields(
    value: object, required: Mapping[str, Check], optional: Mapping[str, Check] | None = None
) -> dict[str, Any]:
    """Check an object's fields: every required one present, nothing unknown."""
    extra = optional or {}
    if not isinstance(value, dict):
        raise invalid_request("expected a JSON object")
    if any(name not in required and name not in extra for name in value):
        raise invalid_request("the object has an unknown field")
    for name in required:
        if name not in value:
            raise invalid_request(f"{name} is required")
    checks = {**required, **extra}
    return {name: checks[name](name, item) for name, item in value.items()}


def integer(low: int, high: int) -> Check:
    """An integer (never a boolean) within [low, high]."""

    def check(name: str, value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise invalid_request(f"{name} must be an integer from {low} to {high}")
        return value

    return check


def snippet_lines(name: str, value: object) -> int | None:
    """`max_snippet_lines`: an integer of at least 0, or null for the whole chunk."""
    return None if value is None else integer(0, MAX_LINE)(name, value)


def text(low: int, high: int) -> Check:
    """A string of `low` to `high` characters."""

    def check(name: str, value: object) -> str:
        if not isinstance(value, str) or not low <= len(value) <= high:
            raise invalid_request(f"{name} must be a string of {low} to {high} characters")
        return value

    return check


def listing(item: Check, low: int, high: int) -> Check:
    """A list of `low` to `high` entries, each passing `item`."""

    def check(name: str, value: object) -> list[Any]:
        if not isinstance(value, list) or not low <= len(value) <= high:
            raise invalid_request(f"{name} must be a list of {low} to {high} entries")
        return [item(name, entry) for entry in value]

    return check


def _content(_name: str, value: object) -> tuple[str, ...]:
    return rules.content(value)


def _path(name: str, value: object) -> str:
    return rules.file_path(value, name)


def _language(name: str, value: object) -> str:
    return rules.identifier(value, rules.LANGUAGE, name)


def _key(name: str, value: object) -> str:
    return rules.identifier(value, rules.KEY, name)


def _index(_name: str, value: object) -> tuple[str, str]:
    checks: dict[str, Check] = {
        "key": _key,
        "label": lambda name, item: rules.identifier(item, rules.LABEL, name),
    }
    entry = fields(value, checks)
    return entry["key"], entry["label"]


def _indexes(name: str, value: object) -> tuple[tuple[str, str], ...]:
    entries = listing(_index, 1, 10)(name, value)
    if len({key for key, _ in entries}) != len(entries):
        raise invalid_request("indexes must name each key once")
    if len({label for _, label in entries}) != len(entries):
        raise invalid_request("indexes must give each label once")
    return tuple(entries)


@dataclass(frozen=True)
class Query:
    """A search or related request; `query` or (`file_path`, `line`) is set by the operation."""

    indexes: tuple[tuple[str, str], ...]
    content: tuple[str, ...]
    top_k: int
    max_snippet_lines: int | None
    query: str = ""
    paths: list[str] | None = None
    languages: list[str] | None = None
    file_path: str = ""
    line: int = 0


_QUERY_COMMON: dict[str, Check] = {
    "indexes": _indexes,
    "content": _content,
    "top_k": integer(1, 200),
    "max_snippet_lines": snippet_lines,
}


def search(body: object) -> Query:
    """Validate a `POST /v1/search` body."""
    required = {**_QUERY_COMMON, "query": text(1, 1000)}
    optional = {"paths": listing(_path, 0, 20), "languages": listing(_language, 0, 20)}
    return Query(**fields(body, required, optional))


def related(body: object) -> Query:
    """Validate a `POST /v1/related` body."""
    required = {**_QUERY_COMMON, "file_path": _path, "line": integer(1, MAX_LINE)}
    return Query(**fields(body, required))


@dataclass(frozen=True)
class Read:
    """A read request."""

    key: str
    file_path: str
    max_lines: int
    start_line: int = 1
    end_line: int | None = None


def read(body: object) -> Read:
    """Validate a `POST /v1/read` body; an end before the start is 400 invalid_range."""
    required = {"key": _key, "file_path": _path, "max_lines": integer(1, 2000)}
    optional = {"start_line": integer(1, MAX_LINE), "end_line": integer(1, MAX_LINE)}
    request = Read(**fields(body, required, optional))
    if request.end_line is not None and request.end_line < request.start_line:
        raise ApiError(400, "invalid_range", "end_line is before start_line")
    return request


def _pattern(name: str, value: object) -> str:
    pattern: str = text(1, MAX_PATTERN_CHARS)(name, value)
    if any(character in pattern for character in "\x00\r\n"):
        raise invalid_request(f"{name} patterns are single lines")
    return pattern


def _spec(name: str, patterns: list[str]) -> GitIgnoreSpec:
    try:
        return GitIgnoreSpec.from_lines(patterns)
    except (ValueError, re.error):
        raise invalid_request(f"{name} holds an invalid pattern") from None


@dataclass(frozen=True)
class BuildSpec:
    """The decoded `X-Vaultgate-Build` header."""

    owner: str
    commit: str
    limits: Limits
    build_timeout_s: int
    variants: tuple[tuple[str, ...], ...]
    include: GitIgnoreSpec | None
    exclude: GitIgnoreSpec


_SPEC: dict[str, Check] = {
    "owner": lambda name, value: rules.identifier(value, rules.OWNER, name),
    "commit": lambda name, value: rules.identifier(value, rules.COMMIT, name),
    "include": listing(_pattern, 0, MAX_PATTERNS),
    "exclude": listing(_pattern, 0, MAX_PATTERNS),
    "max_archive_bytes": integer(1, GIB),
    "max_files": integer(1, 200_000),
    "max_total_bytes": integer(1, 4 * GIB),
    "max_file_bytes": integer(1, 64 << 20),
    "build_timeout_s": integer(1, 3600),
    "variants": listing(_content, 0, 4),
}


def build_spec(header: str | None) -> BuildSpec:
    """Decode and validate the build spec: base64url (no padding) of a JSON object."""
    if header is None or BASE64URL.fullmatch(header) is None or len(header) % 4 == 1:
        raise invalid_request("X-Vaultgate-Build must be base64url without padding")
    raw = base64.urlsafe_b64decode(header + "=" * (-len(header) % 4))
    spec = fields(parse_json(raw), _SPEC)
    limits = Limits(
        spec["max_archive_bytes"],
        spec["max_files"],
        spec["max_total_bytes"],
        spec["max_file_bytes"],
    )
    include = _spec("include", spec["include"]) if spec["include"] else None
    return BuildSpec(
        owner=spec["owner"],
        commit=spec["commit"],
        limits=limits,
        build_timeout_s=spec["build_timeout_s"],
        variants=tuple(dict.fromkeys(spec["variants"])),
        include=include,
        exclude=_spec("exclude", spec["exclude"]),
    )
