"""The JSON-lines log: an event and a fixed set of fields, never content (ACT-116)."""

from __future__ import annotations

import io
import json

import pytest

from vaultgate_code import logs


def test_one_json_line_per_event(capsys: pytest.CaptureFixture[str]) -> None:
    """ACT-116: each event is one JSON line on standard error: time, event and fields."""
    logs.event("request", op="search", status=200, outcome="ok", duration_ms=12, keys=["acme"])
    line = json.loads(capsys.readouterr().err)
    assert set(line) == {"ts", "event", "op", "status", "outcome", "duration_ms", "keys"}
    assert (line["event"], line["keys"]) == ("request", ["acme"])
    assert line["ts"].endswith("Z")


def test_fields_beyond_the_allowed_set_are_refused() -> None:
    """ACT-116: a query, a path or content has no field to travel in."""
    stream = io.StringIO()
    for field in ("query", "file_path", "content", "message"):
        with pytest.raises(ValueError, match="log fields not allowed"):
            logs.event("request", stream, **{field: "x"})
    assert stream.getvalue() == ""
