"""JSON-lines logs on standard error: an event, its keys or owner, a duration and an outcome.

A log line never carries a query, a file path or any repository content; callers pass only
the fields below, and anything else is refused.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from typing import IO

ALLOWED = frozenset(
    {
        "op",
        "key",
        "keys",
        "owner",
        "variant",
        "status",
        "outcome",
        "duration_ms",
        "transport",
        "reason",
        "snapshots",
        "count",
    }
)
_LOCK = threading.Lock()


def event(name: str, stream: IO[str] | None = None, **fields: object) -> None:
    """Write one line: `{"ts", "event", ...fields}`."""
    unknown = set(fields) - ALLOWED
    if unknown:
        raise ValueError(f"log fields not allowed: {sorted(unknown)}")
    line = json.dumps(
        {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": name, **fields},
        separators=(",", ":"),
        default=str,
    )
    with _LOCK:
        target = stream or sys.stderr
        target.write(line + "\n")
        target.flush()
