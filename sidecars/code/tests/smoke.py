"""Smoke test of a running sidecar: build a snapshot, then search, relate and read (ACT-113).

    PYTHONPATH=sidecars/code/tests python3 sidecars/code/tests/smoke.py HOST PORT

CI runs it against the image started with a read-only root filesystem and no capabilities, so
it proves the image verifies its model, serves, spawns its build child and answers from the
index. It uses the standard library and the test suite's archive helpers only.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence

import archives
import repo
from client import Client

QUERY = {
    "indexes": [{"key": "smoke", "label": "smoke"}],
    "content": ["code", "docs", "config"],
    "query": "compute the invoice total with tax",
    "top_k": 3,
    "max_snippet_lines": 2,
}


def check(condition: bool, what: str) -> None:
    """Stop with a message unless `condition` holds."""
    if not condition:
        raise SystemExit(f"smoke: {what}")


def main(argv: Sequence[str]) -> int:
    """Run the checks against HOST PORT; 0 when every one passed."""
    host, port = argv
    client = Client((host, int(port)))
    status, health, _ = client.call("GET", "/v1/health")
    check(status == 200 and health["protocol"] == 1, f"health answered {status}")
    variants = [QUERY["content"]]
    status, meta, _ = client.call(
        "PUT",
        "/v1/snapshots/smoke",
        archives.archive(repo.members()),
        {
            "X-Vaultgate-Build": archives.header(
                max_file_bytes=repo.MAX_FILE_BYTES, variants=variants
            )
        },
    )
    check(status == 200, f"the build answered {status}: {meta}")
    check(meta["variants"]["code+docs+config"]["chunks"] > 0, "the variant has no chunks")
    status, found = client.post("/v1/search", QUERY)
    check(status == 200 and bool(found["results"]), f"search answered {status}")
    check(found["results"][0]["file_path"] == "src/billing/invoice.py", "search ranked oddly")
    related = {k: v for k, v in QUERY.items() if k != "query"} | {
        "file_path": "src/billing/invoice.py",
        "line": 7,
    }
    status, _ = client.post("/v1/related", related)
    check(status == 200, f"related answered {status}")
    status, text = client.post(
        "/v1/read", {"key": "smoke", "file_path": "README.md", "max_lines": 1}
    )
    check(status == 200 and text["text"] == "# Acme widgets", f"read answered {status}")
    status, _, _ = client.call("DELETE", "/v1/snapshots/smoke")
    check(status == 200, f"delete answered {status}")
    client.close()
    sys.stdout.write(
        f"smoke: ok ({health['semble']}, {health['model']}@{health['model_revision']})\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
