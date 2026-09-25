"""Single flight for queries: one build and one load per variant (ACT-107, ACT-112)."""

from __future__ import annotations

import threading
from typing import Any

import pytest

import archives
import childtargets
from conftest import ServiceFactory, put
from test_builder import join_when_waiting
from vaultgate_code import indexes, query
from vaultgate_code.errors import ApiError

SMALL = [
    archives.file("a.py", "def invoice_total():\n    return 1\n"),
    archives.file("b.md", "# Billing\n\nInvoices carry tax.\n"),
]


def search(key: str, content: list[str]) -> dict[str, Any]:
    """A search body over one snapshot."""
    return {
        "indexes": [{"key": key, "label": key}],
        "content": content,
        "query": "invoice tax",
        "top_k": 3,
        "max_snippet_lines": 1,
    }


def test_two_searches_needing_one_variant_build_it_once(make_service: ServiceFactory) -> None:
    """ACT-107: a second search waits for the variant the first is building, then shares it."""
    service = make_service()
    put(service, "acme", SMALL, variants=[])
    release = threading.Event()
    builds: list[str] = []
    real = service.runner.build

    def held(*arguments: Any) -> Any:
        builds.append(arguments[1])
        assert release.wait(60)
        return real(*arguments)

    service.runner.build = held  # type: ignore[method-assign,assignment]
    answers: list[dict[str, Any]] = []
    first = threading.Thread(
        target=lambda: answers.append(query.search(service, search("acme", ["docs"])))
    )
    first.start()
    while not builds:
        threading.Event().wait(0.01)
    second = threading.Thread(
        target=lambda: answers.append(query.search(service, search("acme", ["docs"])))
    )
    join_when_waiting(second)
    release.set()
    first.join()
    second.join()
    assert len(builds) == 1
    assert answers[0] == answers[1]
    assert answers[0]["results"]
    assert service.loaded.usage()[0] == 1


def test_late_joiners_find_the_variant_built_and_loaded(make_service: ServiceFactory) -> None:
    """ACT-107: a flight that starts after another finished reuses its variant and its load."""
    service = make_service()
    put(service, "acme", SMALL, variants=[["code"]])
    snapshot = service.store.get("acme")
    assert snapshot is not None
    info = snapshot.variants["code"]
    assert indexes.build_on_demand(service, snapshot, ("code",)) is info
    loaded = indexes.load(service, snapshot, "code", info, set())
    assert indexes.load(service, snapshot, "code", info, set()) is loaded


def test_deleting_a_snapshot_abandons_its_on_demand_build(make_service: ServiceFactory) -> None:
    """ACT-107: a variant a query is building is killed when its snapshot is deleted."""
    service = make_service()
    put(service, "acme", SMALL, variants=[])
    service.runner._target = childtargets.sleep_forever
    errors: list[ApiError] = []

    def run() -> None:
        with pytest.raises(ApiError) as caught:
            query.search(service, search("acme", ["docs"]))
        errors.append(caught.value)

    worker = threading.Thread(target=run)
    worker.start()
    while service.runner.running == 0:
        threading.Event().wait(0.05)
    assert service.delete("acme") == {"deleted": 1}
    worker.join()
    assert (errors[0].status, errors[0].code, errors[0].detail) == (
        404,
        "snapshot_missing",
        {"key": "acme"},
    )
    assert service.health()["usage"]["building"] == 0
    assert not list(service.store.tmp_dir.iterdir())
