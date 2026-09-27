"""semble's own answers, computed as its MCP server computes them, in a process of their own.

    python3 tests/reference.py < cases.json > answers.json

The parity tests run this in a separate interpreter with an ordinary environment (a fresh home
and `XDG_CACHE_HOME`, none of the variables the sidecar fixes) and without importing
`vaultgate_code`: that is how `semble`'s MCP server runs over a checkout, extracting and loading
its tree-sitter grammars itself. It follows `semble.mcp` (which needs the `mcp` extra, not
installed here): `SembleIndex.from_path` over the resolved directory with the content types in
`ContentType` order, one index per directory and content, `SembleIndex.merge` over the
(repository, index) pairs in the order given, and `format_results`, serialised with `json`. The
MCP server also saves each index to its cache, which changes no answer.

Each case is `{"op": "search" | "related" | "chunks", "repos": [directory, ...], "content":
[...], ...}` with the tool's arguments; `chunks` answers every chunk's [file, start, end] lines.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from semble import ContentType, SembleIndex
from semble.utils import format_results, resolve_chunk

Key = tuple[str, tuple[ContentType, ...]]


class Indexes:
    """The MCP server's cache: one index per resolved directory and exact content selection."""

    def __init__(self, model: str) -> None:
        """Index with the model at `model`."""
        self.model = model
        self.built: dict[Key, SembleIndex] = {}

    def one(self, repo: str, content: list[str]) -> SembleIndex:
        """The index of one directory, built on first use."""
        selected = tuple(kind for kind in ContentType if kind.value in content)
        key = (str(Path(repo).resolve()), selected)
        if key not in self.built:
            self.built[key] = SembleIndex.from_path(key[0], model_path=self.model, content=selected)
        return self.built[key]

    def get(self, repos: list[str], content: list[str]) -> SembleIndex:
        """One directory's index, or several merged as the MCP server merges repositories."""
        unique = list(dict.fromkeys(repos))
        indexes = [self.one(repo, content) for repo in unique]
        if len(indexes) == 1:
            return indexes[0]
        return SembleIndex.merge(list(zip(unique, indexes, strict=True)))


def answer(indexes: Indexes, case: dict[str, Any]) -> Any:
    """One case's answer: the MCP tool's JSON results, or the index's chunks."""
    index = indexes.get(case["repos"], case["content"])
    if case["op"] == "chunks":
        return [[c.file_path, c.start_line, c.end_line] for c in index.chunks]
    lines = case["max_snippet_lines"]
    if case["op"] == "search":
        label = case["query"]
        results = index.search(case["query"], top_k=case["top_k"], max_snippet_lines=lines)
    else:
        seed = resolve_chunk(index.chunks, case["file_path"], case["line"])
        if seed is None:
            raise SystemExit(f"reference: no chunk at {case['file_path']}:{case['line']}")
        label = f"Chunks related to {case['file_path']}:{case['line']}"
        results = index.find_related(seed, top_k=case["top_k"], max_snippet_lines=lines)
    return json.loads(json.dumps(format_results(label, results, lines, index.sources)))["results"]


def main() -> int:
    """Answer every case read from standard input, in order, on standard output."""
    request = json.load(sys.stdin)
    indexes = Indexes(request["model"])
    json.dump([answer(indexes, case) for case in request["cases"]], sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
