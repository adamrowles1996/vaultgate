"""Request validation: every field checked, unknown fields refused (PROTOCOL.md; ACT-110)."""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest

import archives
from vaultgate_code import validate
from vaultgate_code.errors import ApiError

SEARCH = {
    "indexes": [{"key": "acme", "label": "acme"}],
    "content": ["code"],
    "query": "invoice",
    "top_k": 5,
    "max_snippet_lines": 10,
}


def refusal(call: Any) -> tuple[int, str, str]:
    """Run a call expecting an ApiError; (status, code, message)."""
    with pytest.raises(ApiError) as caught:
        call()
    return caught.value.status, caught.value.code, caught.value.message


def encoded(value: object) -> str:
    """Base64url without padding of a JSON value, as the build header carries it."""
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"indexes": []}, "indexes must be a list of 1 to 10 entries"),
        ({"indexes": [{"key": "acme"}]}, "label is required"),
        ({"indexes": ["acme"]}, "expected a JSON object"),
        ({"indexes": [{"key": "a", "label": "x"}, {"key": "a", "label": "y"}]}, "each key once"),
        ({"indexes": [{"key": "a", "label": "x"}, {"key": "b", "label": "x"}]}, "each label once"),
        ({"indexes": [{"key": "acme", "label": "Acme"}]}, "label is malformed"),
        ({"content": []}, "content must be a non-empty list"),
        ({"content": "code"}, "content must be a non-empty list"),
        ({"content": ["code", "tests"]}, "content may hold only code, docs and config"),
        ({"query": ""}, "query must be a string of 1 to 1000 characters"),
        ({"query": "q" * 1001}, "query must be a string of 1 to 1000 characters"),
        ({"top_k": 0}, "top_k must be an integer from 1 to 200"),
        ({"top_k": True}, "top_k must be an integer from 1 to 200"),
        ({"top_k": 5.0}, "top_k must be an integer from 1 to 200"),
        ({"max_snippet_lines": -1}, "max_snippet_lines must be an integer"),
        ({"paths": ["a"] * 21}, "paths must be a list of 0 to 20 entries"),
        ({"paths": [7]}, "paths must be a string"),
        ({"languages": ["python!"]}, "languages is malformed"),
    ],
)
def test_search_fields(change: dict[str, Any], message: str) -> None:
    """ACT-110: each search field is bounded as the protocol says."""
    assert refusal(lambda: validate.search(SEARCH | change))[:2] == (400, "invalid_request")
    assert message in refusal(lambda: validate.search(SEARCH | change))[2]


def test_a_query_names_every_required_field() -> None:
    """ACT-110: a missing field is refused by name; null for max_snippet_lines is the chunk."""
    missing = {k: v for k, v in SEARCH.items() if k != "top_k"}
    assert refusal(lambda: validate.search(missing)) == (
        400,
        "invalid_request",
        "top_k is required",
    )
    assert validate.search(SEARCH | {"max_snippet_lines": None}).max_snippet_lines is None
    assert refusal(lambda: validate.search([SEARCH]))[2] == "expected a JSON object"


def test_bodies_that_are_not_utf8_json() -> None:
    """ACT-113: a body is UTF-8 JSON."""
    for raw in (b"\xff", b"{", b"[" * 100_000):
        assert refusal(lambda raw=raw: validate.parse_json(raw))[1] == "invalid_request"
    assert validate.parse_json(b'{"a": 1}') == {"a": 1}


@pytest.mark.parametrize(
    ("header", "message"),
    [
        (None, "X-Vaultgate-Build must be base64url without padding"),
        ("a+b/", "X-Vaultgate-Build must be base64url without padding"),
        ("abcde", "X-Vaultgate-Build must be base64url without padding"),
        ("abc=", "X-Vaultgate-Build must be base64url without padding"),
        (encoded("not an object"), "expected a JSON object"),
        (encoded(archives.spec() | {"extra": 1}), "unknown field"),
        (encoded({k: v for k, v in archives.spec().items() if k != "owner"}), "owner is required"),
        (encoded(archives.spec(owner="Upper")), "owner is malformed"),
        (encoded(archives.spec(commit="abc")), "commit is malformed"),
        (encoded(archives.spec(include=["a\nb"])), "include patterns are single lines"),
        (encoded(archives.spec(include=[""])), "include must be a string of 1 to 1024"),
        (encoded(archives.spec(exclude=["!"])), "exclude holds an invalid pattern"),
        (encoded(archives.spec(exclude=["[z-a]"])), "exclude holds an invalid pattern"),
        (encoded(archives.spec(exclude=["x"] * 101)), "exclude must be a list of 0 to 100"),
        (encoded(archives.spec(variants=[["code"]] * 5)), "variants must be a list of 0 to 4"),
        (encoded(archives.spec(max_files=0)), "max_files must be an integer"),
        (encoded(archives.spec(build_timeout_s=3601)), "build_timeout_s must be an integer"),
    ],
)
def test_the_build_spec_header(header: str | None, message: str) -> None:
    """ACT-106: the build spec is base64url JSON, every field checked, nothing unknown."""
    status, code, text = refusal(lambda: validate.build_spec(header))
    assert (status, code) == (400, "invalid_request")
    assert message in text


def test_a_valid_build_spec() -> None:
    """ACT-107: variants normalised and deduplicated; an empty include includes everything."""
    spec = validate.build_spec(
        encoded(archives.spec(variants=[["docs", "code"], ["code", "docs", "code"], ["config"]]))
    )
    assert spec.variants == (("code", "docs"), ("config",))
    assert spec.include is None
    assert spec.exclude.match_file("deploy/.env")
    included = validate.build_spec(encoded(archives.spec(include=["src/"])))
    assert included.include is not None
    assert included.include.match_file("src/a.py")
