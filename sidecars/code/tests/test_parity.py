"""Parity: the sidecar answers exactly as semble's own MCP server does over the same commit.

The reference answers come from `reference.py` in a separate interpreter with an ordinary
environment: a fresh home and `XDG_CACHE_HOME`, none of the variables the sidecar fixes, and
nothing of `vaultgate_code` imported, as `semble`'s MCP server runs over a checkout. A reference
computed inside the sidecar's own process shares whatever that process gets wrong: when the
sidecar's environment kept `semble` from loading its grammars, both sides chunked by lines and
agreed. The sidecar's answers come from snapshots of the same tree, through its archive
extraction, its build child, `save()`, `load_from_disk()` and its own merge labels. The tree
holds files longer than one chunk (`chunked`), so chunking by lines cannot match.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

import archives
import chunked
import repo
from conftest import Clock, config_for
from vaultgate_code import environment, fetch_model, grammars, query
from vaultgate_code.service import Service

REFERENCE = Path(__file__).with_name("reference.py")
QUERIES = [
    "compute invoice total with tax",
    "rotate the refresh token",
    "refund more than paid",
    "registerRoutes",
    "session minutes",
    "run the deployment steps with retries",
    "start the server and match a route",
    "the canary host and its health check",
]
CONTENTS = [["code"], ["docs"], ["code", "docs", "config"]]
RELATED = [
    ("src/billing/invoice.py", 7),
    ("src/auth/session.py", 1),
    ("src/web/router.ts", 4),
    ("src/deploy/plan.py", 20),
    ("src/web/server.ts", 30),
]
LABELS = ("alpha", "beta")
MERGED = ["beta", "alpha"]


@dataclass
class Parity:
    """The sidecar over snapshots `alpha` and `beta`, and the reference's answer to each case."""

    service: Service
    answers: dict[str, Any]


def ordinary_environment(root: Path) -> dict[str, str]:
    """A shell's environment: its own home and cache, and nothing the sidecar sets."""
    home, cache = root / "home", root / "cache"
    for directory in (home, cache):
        directory.mkdir()
    dropped = {*environment.FIXED, grammars.ENV, "PYTHONPATH"}
    prefixes = ("HF_", "SEMBLE_", "XDG_", "VAULTGATE_CODE_", "TOKENIZERS_")
    kept = {
        name: value
        for name, value in os.environ.items()
        if name not in dropped and not name.startswith(prefixes)
    }
    return kept | {"HOME": str(home), "XDG_CACHE_HOME": str(cache)}


def cases(trees: dict[str, Path]) -> dict[str, dict[str, Any]]:
    """Every reference case by name: searches, merged searches, related and chunk lists."""
    found: dict[str, dict[str, Any]] = {}
    for content in CONTENTS:
        name = "+".join(content)
        alpha = [str(trees["alpha"])]
        found[f"chunks {name}"] = {"op": "chunks", "repos": alpha, "content": content}
        for lines in (None, 0, 3):
            for text in QUERIES:
                found[f"search {name} {lines} {text}"] = {
                    "op": "search",
                    "repos": [str(trees["alpha"])],
                    "content": content,
                    "query": text,
                    "top_k": 7,
                    "max_snippet_lines": lines,
                }
    for text in QUERIES:
        found[f"merged {text}"] = {
            "op": "search",
            "repos": [str(trees[label]) for label in MERGED],
            "content": ["code"],
            "query": text,
            "top_k": 9,
            "max_snippet_lines": 2,
        }
    for path, line in RELATED:
        found[f"related {path} {line}"] = {
            "op": "related",
            "repos": [str(trees["alpha"])],
            "content": ["code"],
            "file_path": path,
            "line": line,
            "top_k": 5,
            "max_snippet_lines": None,
        }
    return found


def reference(root: Path, model: Path, wanted: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Run `reference.py` over the cases in an ordinary environment; its answers by name."""
    request = json.dumps({"model": str(model), "cases": list(wanted.values())})
    done = subprocess.run(  # noqa: S603 - this interpreter, a fixed script
        [sys.executable, str(REFERENCE)],
        input=request,
        capture_output=True,
        text=True,
        cwd=root,
        env=ordinary_environment(root),
        check=False,
        timeout=600,
    )
    assert done.returncode == 0, done.stderr
    return dict(zip(wanted, json.loads(done.stdout), strict=True))


@pytest.fixture(scope="module")
def parity(
    tmp_path_factory: pytest.TempPathFactory,
    model_dir: Path,
    manifest: fetch_model.Manifest,
    grammars_dir: Path,
    bundle: grammars.Bundle,
) -> Iterator[Parity]:
    """Checkouts `alpha` and `beta` of one tree, the reference's answers and the sidecar's."""
    root = tmp_path_factory.mktemp("parity")
    everything = repo.FILES | chunked.FILES
    trees = {label: repo.write(root / "checkouts" / label, everything) for label in LABELS}
    answers = reference(root, model_dir, cases(trees))
    config = config_for(root / "state", model_dir, grammars_dir)
    service = Service(config, manifest, bundle, Clock(), lambda: None)
    service.store.reconcile()
    members = repo.members() + [archives.file(name, data) for name, data in chunked.FILES.items()]
    header = archives.header(variants=CONTENTS, max_file_bytes=repo.MAX_FILE_BYTES)
    for label in LABELS:
        service.put(label, header, io.BytesIO(archives.archive(members)))
    yield Parity(service, answers)
    service.runner.stop()


def shape(results: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    """The fields compared, in order: path, lines, score, snippet."""
    return [
        (r["file_path"], r["start_line"], r["end_line"], r["score"], r.get("content"))
        for r in results
    ]


def search(parity: Parity, indexes: list[str], content: list[str], **request: Any) -> Any:
    """The sidecar's search over snapshots named by label."""
    named = [{"key": label, "label": label} for label in indexes]
    body = {"indexes": named, "content": content, **request}
    return query.search(parity.service, body)["results"]


def test_the_reference_chunks_by_syntax_tree(parity: Parity) -> None:
    """ACT-117: semble's own index cuts the long files along their syntax trees, not by lines."""
    for content in CONTENTS:
        chunks = parity.answers[f"chunks {'+'.join(content)}"]
        for path, spans in chunked.TREE_SITTER.items():
            found = [(start, end) for file, start, end in chunks if file == path]
            assert found in ([], spans)
    plan = [(s, e) for f, s, e in parity.answers["chunks code"] if f == "src/deploy/plan.py"]
    assert plan == [(1, 13), (16, 26), (29, 39)]


@pytest.mark.parametrize("content", CONTENTS)
@pytest.mark.parametrize("lines", [None, 0, 3])
def test_single_index_parity(parity: Parity, content: list[str], lines: int | None) -> None:
    """ACT-107, ACT-117: one index gives semble's results, lines, scores and snippets exactly."""
    name = "+".join(content)
    for text in QUERIES:
        ours = search(parity, ["alpha"], content, query=text, top_k=7, max_snippet_lines=lines)
        assert shape(ours) == shape(parity.answers[f"search {name} {lines} {text}"])


def test_merged_index_parity(parity: Parity) -> None:
    """ACT-110, ACT-117: several indexes give semble's multi-repo results and prefixes exactly."""
    for text in QUERIES:
        ours = search(parity, MERGED, ["code"], query=text, top_k=9, max_snippet_lines=2)
        theirs = parity.answers[f"merged {text}"]
        assert shape(ours) == shape(theirs)
        assert [r["label"] for r in ours] == [r["file_path"].split("/")[0] for r in theirs]


def test_related_parity(parity: Parity) -> None:
    """ACT-110, ACT-117: related uses semble's seed rule and gives its results exactly."""
    for path, line in RELATED:
        ours = query.related(
            parity.service,
            {
                "indexes": [{"key": "alpha", "label": "alpha"}],
                "content": ["code"],
                "file_path": path,
                "line": line,
                "top_k": 5,
                "max_snippet_lines": None,
            },
        )
        assert shape(ours["results"]) == shape(parity.answers[f"related {path} {line}"])
