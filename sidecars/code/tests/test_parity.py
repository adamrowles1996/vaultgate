"""Parity: the sidecar answers exactly as semble's own MCP server functions would.

semble's MCP server builds `SembleIndex.from_path(repo, content=..., model_path=...)`, merges
several with `SembleIndex.merge([(repo, index), ...])`, and renders with `format_results`. The
reference below does exactly that over the same files; the sidecar went through an archive, a
child build, save(), load_from_disk() and its own merge labels.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from semble import ContentType, SembleIndex
from semble.utils import format_results, resolve_chunk

import repo
from conftest import MODEL_DIR
from vaultgate_code import query
from vaultgate_code.service import Service

QUERIES = [
    "compute invoice total with tax",
    "rotate the refresh token",
    "refund more than paid",
    "registerRoutes",
    "session minutes",
]
CONTENTS = [["code"], ["docs"], ["code", "docs", "config"]]


def reference(
    index: SembleIndex, query_text: str, top_k: int, lines: int | None
) -> list[dict[str, Any]]:
    """What semble's MCP `search` returns (its JSON results list)."""
    results = index.search(query_text, top_k=top_k, max_snippet_lines=lines)
    return list(format_results(query_text, results, lines, index.sources)["results"])


def shape(results: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    """The fields compared: path, lines, score, content."""
    return [
        (r["file_path"], r["start_line"], r["end_line"], r["score"], r.get("content"))
        for r in results
    ]


def build(root: Path, content: list[str]) -> SembleIndex:
    """semble's own index over a directory."""
    return SembleIndex.from_path(
        root, content=[ContentType(c) for c in content], model_path=str(MODEL_DIR)
    )


@pytest.fixture(scope="module")
def trees(tmp_path_factory: pytest.TempPathFactory, shared: Service) -> dict[str, Path]:
    """The snapshot's files written plainly, as `alpha` (acme) and `beta` (acme-code)."""
    del shared
    root = tmp_path_factory.mktemp("parity")
    return {label: repo.write(root / label) for label in ("alpha", "beta")}


@pytest.mark.parametrize("content", CONTENTS)
@pytest.mark.parametrize("lines", [None, 0, 3])
def test_single_index_parity(
    shared: Service, trees: dict[str, Path], content: list[str], lines: int | None
) -> None:
    """ACT-107, ACT-110: one index gives semble's results, scores and snippets exactly."""
    index = build(trees["alpha"], content)
    for text in QUERIES:
        ours = query.search(
            shared,
            {
                "indexes": [{"key": "acme", "label": "alpha"}],
                "content": content,
                "query": text,
                "top_k": 7,
                "max_snippet_lines": lines,
            },
        )
        assert shape(ours["results"]) == shape(reference(index, text, 7, lines))


def test_merged_index_parity(shared: Service, trees: dict[str, Path]) -> None:
    """ACT-110: several indexes give semble's multi-repo results, labels and prefixes exactly."""
    alpha, beta = build(trees["alpha"], ["code"]), build(trees["beta"], ["code"])
    merged = SembleIndex.merge([(str(trees["beta"]), beta), (str(trees["alpha"]), alpha)])
    indexes = [{"key": "acme-code", "label": "beta"}, {"key": "acme", "label": "alpha"}]
    for text in QUERIES:
        ours = query.search(
            shared,
            {
                "indexes": indexes,
                "content": ["code"],
                "query": text,
                "top_k": 9,
                "max_snippet_lines": 2,
            },
        )
        theirs = reference(merged, text, 9, 2)
        assert shape(ours["results"]) == shape(theirs)
        assert [r["label"] for r in ours["results"]] == [
            r["file_path"].split("/")[0] for r in theirs
        ]


def test_related_parity(shared: Service, trees: dict[str, Path]) -> None:
    """ACT-110: related uses semble's seed rule and gives its results exactly."""
    index = build(trees["alpha"], ["code"])
    for path, line in [
        ("src/billing/invoice.py", 7),
        ("src/auth/session.py", 1),
        ("src/web/router.ts", 4),
    ]:
        seed = resolve_chunk(index.chunks, path, line)
        assert seed is not None
        results = index.find_related(seed, top_k=5, max_snippet_lines=None)
        theirs = format_results("", results, None)["results"]
        ours = query.related(
            shared,
            {
                "indexes": [{"key": "acme", "label": "alpha"}],
                "content": ["code"],
                "file_path": path,
                "line": line,
                "top_k": 5,
                "max_snippet_lines": None,
            },
        )
        assert shape(ours["results"]) == shape(theirs)
