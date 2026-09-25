"""`semble`, used as a library: the pinned model, variant builds and loads, result rendering.

`semble` 0.6.1 has no switch for its per-user index cache or its token-savings statistics file,
and it reloads the model from the path an index was saved with. Four of its module globals are
therefore replaced, here and nowhere else: its cache lookup and incremental reuse find nothing,
its statistics writer does nothing, and every model load returns the one model this process
verified at start-up. `semble`'s MCP server module and `SembleIndex.from_git` are never used.
The package's `__init__` has already fixed the environment `semble` reads when it is imported.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import orjson
import semble
import semble.index.index as semble_index
from model2vec import StaticModel
from semble import ContentType, SearchResult, SembleIndex
from semble.index.types import CACHE_FORMAT_VERSION
from semble.utils import format_results

SEMBLE_VERSION = "0.6.1"
NOTHING_TO_INDEX = "No supported files found"


@dataclass
class _Model:
    model: StaticModel | None = None
    directory: str = ""


_MODEL = _Model()


def check_semble(version: str = semble.__version__) -> None:
    """Refuse to run against a `semble` other than the one the replacements below were read from."""
    if version != SEMBLE_VERSION:
        raise RuntimeError(f"semble {SEMBLE_VERSION} is required, found {version}")


def use_model(directory: str) -> None:
    """Load the model from a verified local directory; every later load returns it."""
    _MODEL.model = StaticModel.from_pretrained(directory, force_download=False)
    _MODEL.directory = directory


def pinned_model(model_path: str | None = None) -> tuple[StaticModel, str]:
    """Stand in for `semble.index.dense.load_model`, ignoring the path an index recorded."""
    del model_path
    if _MODEL.model is None:
        raise RuntimeError("the model is not loaded")
    return _MODEL.model, _MODEL.directory


def no_cached_index(path: str, model_path: str | None, content: Sequence[ContentType]) -> None:
    """Stand in for `semble`'s cache lookups: there is never a cached index to reuse."""
    del path, model_path, content


def no_statistics(
    results: list[SearchResult],
    call_type: object,
    file_sizes: dict[str, int],
    max_snippet_lines: int | None = None,
) -> None:
    """Stand in for `semble.stats.save_search_stats`: nothing is recorded."""
    del results, call_type, file_sizes, max_snippet_lines


semble_index.load_model = pinned_model  # type: ignore[attr-defined]
semble_index.get_validated_cache = no_cached_index  # type: ignore[attr-defined]
semble_index.load_previous_for_incremental = no_cached_index  # type: ignore[attr-defined]
semble_index.save_search_stats = no_statistics  # type: ignore[attr-defined]


def content_types(content: Sequence[str]) -> list[ContentType]:
    """Map normalised content names to `semble`'s enum."""
    return [ContentType(name) for name in content]


def build_variant(tree: str, out: str, content: Sequence[str]) -> tuple[int, int]:
    """Index `tree` for `content`, save the index into `out` and return (files, chunks).

    A tree with nothing `semble` can index gives (0, 0) and an empty `out`.
    """
    Path(out).mkdir(mode=0o755)
    try:
        index = SembleIndex.from_path(
            tree, content=content_types(content), model_path=_MODEL.directory
        )
    except ValueError as error:
        if not str(error).startswith(NOTHING_TO_INDEX):
            raise
        return 0, 0
    index.save(out)
    _scrub_metadata(Path(out) / "metadata.json")
    stats = index.stats
    return stats.indexed_files, stats.total_chunks


def _scrub_metadata(path: Path) -> None:
    """Drop the host paths `save()` records: the tree it read and the model directory."""
    metadata = orjson.loads(path.read_bytes())
    metadata["root_path"] = None
    metadata["model_path"] = "pinned"
    path.write_bytes(orjson.dumps(metadata))


def load_variant(directory: str) -> SembleIndex:
    """Load a saved variant; the model is the pinned one, whatever the metadata says."""
    return SembleIndex.load_from_disk(directory)


def merge(parts: Sequence[tuple[str, SembleIndex]]) -> SembleIndex:
    """Merge labelled indexes as `semble`'s MCP server merges repositories.

    `SembleIndex.merge` labels each part with the last segment of its source, so a source of
    `https://vaultgate.invalid/<label>` (used for nothing but that label) prefixes every file
    path with exactly `<label>/`.
    """
    sources = {label: f"https://vaultgate.invalid/{label}" for label, _ in parts}
    merged = SembleIndex.merge([(sources[label], index) for label, index in parts])
    if merged.sources != sources:
        raise RuntimeError("semble labelled the merged indexes unexpectedly")
    return merged


def render(results: list[SearchResult], max_snippet_lines: int | None) -> list[dict[str, Any]]:
    """Render results with `semble`'s `format_results`, adding the language, scores as floats."""
    formatted: list[dict[str, Any]] = format_results("", results, max_snippet_lines)["results"]
    for entry, result in zip(formatted, results, strict=True):
        entry["score"] = float(entry["score"])
        entry["language"] = result.chunk.language
    return formatted


VERSIONS = {"semble": SEMBLE_VERSION, "cache_format": CACHE_FORMAT_VERSION}
