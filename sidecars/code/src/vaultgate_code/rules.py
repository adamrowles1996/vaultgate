"""Identifiers, content selections and the path rules (ACT-106, ACT-111)."""

from __future__ import annotations

import re

from vaultgate_code.errors import ApiError, invalid_path, invalid_request

KEY = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}")
OWNER = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
LABEL = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
COMMIT = re.compile(r"[0-9a-f]{40}")
LANGUAGE = re.compile(r"[A-Za-z0-9_.+#-]{1,64}")
CONTENT_ORDER = ("code", "docs", "config")
MAX_PATH_BYTES = 1024


def identifier(value: object, pattern: re.Pattern[str], name: str) -> str:
    """Return `value` if it is a string matching `pattern`, else 400 invalid_request."""
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise invalid_request(f"{name} is malformed")
    return value


def content(value: object) -> tuple[str, ...]:
    """Normalise a content selection to `code`, `docs`, `config` order, without duplicates."""
    if not isinstance(value, list) or not 1 <= len(value) <= len(CONTENT_ORDER) * 4:
        raise invalid_request("content must be a non-empty list")
    if any(item not in CONTENT_ORDER for item in value):
        raise invalid_request("content may hold only code, docs and config")
    return tuple(name for name in CONTENT_ORDER if name in value)


def variant_name(selection: tuple[str, ...]) -> str:
    """Name a variant by its normalised content joined with `+`."""
    return "+".join(selection)


def path_problem(path: str, max_bytes: int | None = MAX_PATH_BYTES) -> str | None:
    """Say why `path` is not a canonical repository-relative POSIX path, or return None.

    Refused: a NUL, a backslash, an absolute path, an empty, `.` or `..` segment, a name that
    is not UTF-8, and (when `max_bytes` is set) more than `max_bytes` bytes.
    """
    problem = None
    if "\x00" in path:
        problem = "contains a NUL"
    elif "\\" in path:
        problem = "contains a backslash"
    elif path.startswith("/"):
        problem = "is absolute"
    elif any(segment in {"", ".", ".."} for segment in path.split("/")):
        problem = "has an empty, . or .. segment"
    else:
        try:
            size = len(path.encode("utf-8"))
        except UnicodeEncodeError:
            problem = "is not UTF-8"
        else:
            if max_bytes is not None and size > max_bytes:
                problem = f"is longer than {max_bytes} bytes"
    return problem


def file_path(value: object, name: str = "file_path") -> str:
    """Return a path argument that obeys the path rules, else 400 invalid_path."""
    if not isinstance(value, str):
        raise invalid_request(f"{name} must be a string")
    problem = path_problem(value)
    if problem is not None:
        raise invalid_path(f"{name} {problem}")
    return value


def path_not_found() -> ApiError:
    """404: the path is not a regular file of the snapshot."""
    return ApiError(404, "path_not_found", "no such file in the snapshot")
