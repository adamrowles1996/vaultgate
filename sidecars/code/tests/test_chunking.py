"""Chunking: the sidecar's indexes are cut along tree-sitter syntax trees, never silently by lines.

`semble` falls back to chunking by lines whenever a grammar fails to load. The sidecar replaces
its parser lookup so that only a language with no bundled grammar falls back, as in `semble`;
a bundled grammar that cannot be loaded fails the build instead.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import semble.chunking.core as semble_chunking
import semble_grammars
from semble.chunking import chunk_source
from semble_grammars.cache import cache_dir

import archives
import chunked
from conftest import ServiceFactory, put
from vaultgate_code import engine, grammars
from vaultgate_code.errors import ApiError
from vaultgate_code.service import Service

MEMBERS = [archives.file(name, data) for name, data in chunked.FILES.items()]
LANGUAGES = {"src/deploy/plan.py": "python", "src/web/server.ts": "typescript"}


def spans(service: Service, key: str, variant: str, path: str) -> list[tuple[int, int]]:
    """The (start, end) lines of one file's chunks in a built variant, in order."""
    directory = service.store.path(key) / "variants" / variant
    index = engine.load_variant(str(directory))
    return [(c.start_line, c.end_line) for c in index.chunks if c.file_path == path]


def by_lines(path: str) -> list[tuple[int, int]]:
    """The same file chunked by lines, as `semble` chunks a language it has no grammar for."""
    source = chunked.FILES[path].decode()
    return [(c.start_line, c.end_line) for c in chunk_source(source, path, None)]


def test_the_sidecar_chunks_by_syntax_tree(make_service: ServiceFactory) -> None:
    """ACT-107, ACT-117: Python, TypeScript and Markdown are chunked along their syntax trees."""
    service = make_service()
    put(service, "deploy", MEMBERS, variants=[["code"], ["docs"]])
    for path, expected in chunked.TREE_SITTER.items():
        variant = "docs" if path.endswith(".md") else "code"
        assert spans(service, "deploy", variant, path) == expected
        assert expected != by_lines(path)
    index = engine.load_variant(str(service.store.path("deploy") / "variants" / "code"))
    assert {c.file_path: c.language for c in index.chunks} == LANGUAGES


def test_a_build_whose_grammars_cannot_load_fails(
    make_service: ServiceFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-107: a build child that cannot load a grammar fails the build, never chunks by lines."""
    service = make_service()
    monkeypatch.setenv(grammars.ENV, "/dev/null/vaultgate-code/grammars")
    with pytest.raises(ApiError) as caught:
        put(service, "deploy", MEMBERS)
    error = caught.value
    assert (error.status, error.code, error.message) == (422, "build_failed", "GrammarUnavailable")
    assert error.detail is not None
    assert error.detail["variant"] == "code"
    assert service.store.get("deploy") is None


def test_semble_uses_the_strict_parser_lookup() -> None:
    """ACT-107: semble's chunking calls the sidecar's lookup, which finds bundled parsers."""
    assert semble_chunking._cached_get_parser is engine.strict_parser
    for language in engine.CHECKED_LANGUAGES:
        assert engine.strict_parser(language) is not None
    engine.check_chunking()


def test_a_language_without_a_grammar_is_still_chunked_by_lines() -> None:
    """ACT-107: a language semble-grammars does not bundle falls back to lines, as in semble."""
    assert "cobol" not in semble_grammars.available_languages()
    assert engine.strict_parser("cobol") is None
    with pytest.raises(engine.GrammarUnavailable, match="no tree-sitter parser for cobol"):
        engine.check_chunking(["cobol"])


def test_a_bundled_grammar_that_fails_to_load_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """ACT-107: a grammar that fails to load raises GrammarUnavailable, not an OSError."""

    def broken(language: str) -> None:
        raise semble_grammars.GrammarLoadError(language)

    monkeypatch.setattr(semble_grammars, "get_parser", broken)
    with pytest.raises(engine.GrammarUnavailable, match="GrammarLoadError") as caught:
        engine.strict_parser.__wrapped__("python")
    assert not isinstance(caught.value, OSError)


def test_without_the_directory_nothing_could_be_extracted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ACT-113: without the prepared directory, semble-grammars' own cache is below /dev/null."""
    monkeypatch.delenv(grammars.ENV)
    cache = cache_dir()
    assert Path("/dev/null") in cache.parents
