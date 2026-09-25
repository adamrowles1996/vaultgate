"""Search and related with the real pinned model and real semble (ACT-107, ACT-110)."""

from __future__ import annotations

from typing import Any

import pytest

from archives import file
from conftest import ServiceFactory, put
from vaultgate_code import query
from vaultgate_code.errors import ApiError
from vaultgate_code.service import Service

ACME = [{"key": "acme", "label": "acme"}]
DOCS = {".md", ".txt"}
CONFIG = {".yaml", ".json"}
CODE = {".py", ".ts"}


def search(service: Service, **body: Any) -> dict[str, Any]:
    """POST /v1/search through the service, with defaults."""
    request = {
        "indexes": ACME,
        "content": ["code"],
        "query": "invoice total with tax",
        "top_k": 5,
        "max_snippet_lines": 10,
    } | body
    return query.search(service, request)


def related(service: Service, **body: Any) -> dict[str, Any]:
    """POST /v1/related through the service, with defaults."""
    request = {"indexes": ACME, "content": ["code"], "top_k": 5, "max_snippet_lines": 10} | body
    return query.related(service, request)


def suffixes(answer: dict[str, Any]) -> set[str]:
    """The file extensions of the results."""
    return {"." + r["file_path"].rsplit(".", 1)[-1] for r in answer["results"]}


@pytest.mark.parametrize(
    ("content", "allowed"),
    [
        (["code"], CODE),
        (["docs"], DOCS),
        (["config"], CONFIG),
        (["code", "docs", "config"], CODE | DOCS | CONFIG),
    ],
)
def test_each_content_selection_searches_its_own_variant(
    shared: Service, content: list[str], allowed: set[str]
) -> None:
    """ACT-107, ACT-110: a variant indexes exactly its content selection."""
    answer = search(shared, content=content, query="invoice refund session token", top_k=50)
    assert answer["results"]
    assert suffixes(answer) <= allowed
    assert answer["variants"][0]["variant"] == "+".join(content)
    for result in answer["results"]:
        assert type(result["score"]) is float
        assert result["label"] == "acme"


def test_content_is_normalised(shared: Service) -> None:
    """ACT-110: content order and duplicates do not matter."""
    answer = search(shared, content=["config", "code", "docs", "code"])
    assert answer["variants"] == [
        {
            "key": "acme",
            "variant": "code+docs+config",
            "chunks": answer["variants"][0]["chunks"],
            "built_at": answer["variants"][0]["built_at"],
        }
    ]


def test_max_snippet_lines(shared: Service) -> None:
    """ACT-110: null gives the whole chunk, 0 leaves content out, N gives the first N lines."""
    whole = search(shared, max_snippet_lines=None)["results"]
    none = search(shared, max_snippet_lines=0)["results"]
    two = search(shared, max_snippet_lines=2)["results"]
    assert (
        [r["file_path"] for r in whole]
        == [r["file_path"] for r in none]
        == [r["file_path"] for r in two]
    )
    assert all("content" not in r for r in none)
    for full, cut in zip(whole, two, strict=True):
        assert cut["content"] == "\n".join(full["content"].splitlines()[:2])
    assert any(len(r["content"].splitlines()) > 2 for r in whole)


def test_top_k_bounds_the_results(shared: Service) -> None:
    """ACT-110: at most top_k results, best first."""
    one = search(shared, top_k=1)["results"]
    many = search(shared, top_k=200)["results"]
    assert len(one) == 1
    assert one[0]["file_path"] == many[0]["file_path"] == "src/billing/invoice.py"
    assert [r["score"] for r in many] == sorted((r["score"] for r in many), reverse=True)


def test_paths_and_languages_filters(shared: Service) -> None:
    """ACT-110: paths and languages pass to semble's filters."""
    only = search(shared, paths=["src/billing/refund.py"], query="refund")["results"]
    assert {r["file_path"] for r in only} == {"src/billing/refund.py"}
    markdown = search(shared, content=["code", "docs", "config"], languages=["markdown"], top_k=20)
    assert {r["language"] for r in markdown["results"]} == {"markdown"}


def test_several_indexes_merge_with_label_prefixes(shared: Service) -> None:
    """ACT-110: several indexes merge as semble merges repositories: `<label>/<path>`."""
    indexes = [{"key": "acme", "label": "alpha"}, {"key": "acme-code", "label": "beta"}]
    answer = search(shared, indexes=indexes, top_k=20)
    labels = {r["label"] for r in answer["results"]}
    assert labels == {"alpha", "beta"}
    for result in answer["results"]:
        assert result["file_path"].startswith(result["label"] + "/")
    assert [v["key"] for v in answer["variants"]] == ["acme", "acme-code"]
    filtered = search(shared, indexes=indexes, paths=["beta/src/billing/invoice.py"])["results"]
    assert {r["file_path"] for r in filtered} == {"beta/src/billing/invoice.py"}
    again = search(shared, indexes=indexes, top_k=20)
    assert again["results"] == answer["results"]  # served by the cached merge


def test_related_finds_similar_chunks(shared: Service) -> None:
    """ACT-110: related seeds with the chunk holding the line, excluding the seed itself."""
    answer = related(shared, file_path="src/billing/invoice.py", line=7)
    assert answer["results"]
    assert all(
        r["file_path"] != "src/billing/invoice.py" or r["start_line"] > 7 for r in answer["results"]
    )
    merged = related(
        shared,
        indexes=[{"key": "acme", "label": "alpha"}, {"key": "acme-code", "label": "beta"}],
        file_path="alpha/src/auth/session.py",
        line=3,
    )
    assert all(r["file_path"].split("/", 1)[0] in {"alpha", "beta"} for r in merged["results"])


@pytest.mark.parametrize(
    "location",
    [
        ("src/billing/invoice.py", 10_000),
        ("docs/billing.md", 1),
        ("beta/src/billing/invoice.py", 1),
    ],
)
def test_related_without_a_chunk_is_chunk_not_found(
    shared: Service, location: tuple[str, int]
) -> None:
    """ACT-110: no chunk holds that line (or that file is not in the variant): chunk_not_found."""
    path, line = location
    with pytest.raises(ApiError) as caught:
        related(shared, file_path=path, line=line)
    assert (caught.value.status, caught.value.code) == (404, "chunk_not_found")


def test_a_missing_key_is_snapshot_missing(shared: Service) -> None:
    """ACT-110: a key with no snapshot is 404 snapshot_missing naming it."""
    with pytest.raises(ApiError) as caught:
        search(shared, indexes=[*ACME, {"key": "nope", "label": "nope"}])
    assert (caught.value.status, caught.value.code, caught.value.detail) == (
        404,
        "snapshot_missing",
        {"key": "nope"},
    )


def test_a_variant_with_nothing_to_index_has_no_chunks(make_service: ServiceFactory) -> None:
    """ACT-107: a tree with nothing semble indexes gives the variant chunks 0, not a failure."""
    service = make_service()
    meta = put(service, "docs-only", [file("README.md", "# only docs\n")], variants=[["code"]])
    assert meta["variants"]["code"] == meta["variants"]["code"] | {"files": 0, "chunks": 0}
    assert search(service, indexes=[{"key": "docs-only", "label": "d"}])["results"] == []
    put(service, "code", [file("a.py", "def invoice_total():\n    return 1\n")])
    both = [{"key": "docs-only", "label": "d"}, {"key": "code", "label": "c"}]
    results = search(service, indexes=both)["results"]
    assert results
    assert {r["file_path"] for r in results} == {"c/a.py"}
    put(service, "docs-too", [file("b.md", "# b\n")])
    empty = [{"key": "docs-only", "label": "d"}, {"key": "docs-too", "label": "e"}]
    assert search(service, indexes=empty)["results"] == []
    with pytest.raises(ApiError) as caught:
        related(service, indexes=empty, file_path="d/README.md", line=1)
    assert caught.value.code == "chunk_not_found"


def test_queries_update_last_used_at(shared: Service) -> None:
    """ACT-110: search, related and read each record a use of the snapshot."""
    snapshot = shared.store.get("acme-code")
    assert snapshot is not None
    before = snapshot.last_used_at
    search(shared, indexes=[{"key": "acme-code", "label": "a"}])
    after_search = snapshot.last_used_at
    related(
        shared,
        indexes=[{"key": "acme-code", "label": "a"}],
        file_path="src/auth/session.py",
        line=3,
    )
    after_related = snapshot.last_used_at
    query.read(shared, {"key": "acme-code", "file_path": "README.md", "max_lines": 1})
    assert before < after_search < after_related < snapshot.last_used_at
