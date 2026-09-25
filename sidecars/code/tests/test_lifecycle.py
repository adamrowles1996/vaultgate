"""Build, status, list and delete through the service (PROTOCOL.md; ACT-106, ACT-107)."""

from __future__ import annotations

import io
import multiprocessing
import threading
from pathlib import Path
from typing import Any

import pytest

import archives
import childtargets
import repo
from bodies import Gated, Refusing
from conftest import ServiceFactory, put
from vaultgate_code.errors import ApiError
from vaultgate_code.service import Service


def failure(call: Any) -> ApiError:
    """Run a call expecting an ApiError."""
    with pytest.raises(ApiError) as caught:
        call()
    return caught.value


def tmp_is_empty(service: Service) -> bool:
    """Nothing is left in tmp/."""
    return not list(service.store.tmp_dir.iterdir())


def test_a_build_returns_the_snapshot_metadata(make_service: ServiceFactory) -> None:
    """ACT-106, ACT-107: the metadata counts files, bytes, skips and each variant's chunks."""
    service = make_service()
    meta = put(
        service, "acme", variants=[["code"], ["docs", "code"]], max_file_bytes=repo.MAX_FILE_BYTES
    )
    assert meta["key"] == "acme"
    assert meta["owner"] == "target-1"
    assert meta["commit"] == archives.COMMIT
    assert meta["files"] == len(repo.FILES)
    assert meta["bytes"] == sum(len(data) for data in repo.FILES.values())
    assert meta["skipped"] == {"links": 2, "special": 0, "excluded": 2, "large": 1}
    assert set(meta["variants"]) == {"code", "code+docs"}
    code = meta["variants"]["code"]
    assert code["files"] == 4  # empty.py has no chunk
    assert code["chunks"] > 0
    assert set(code) == {"files", "chunks", "built_at", "duration_ms", "storage_bytes"}
    assert meta["storage_bytes"] > sum(v["storage_bytes"] for v in meta["variants"].values())
    assert meta["created_at"] == meta["last_used_at"]
    assert service.status("acme") == (200, meta)
    assert service.list_snapshots() == {"snapshots": [meta], "building": []}
    assert tmp_is_empty(service)
    tree = service.store.path("acme") / "tree"
    assert sorted(p.relative_to(tree).as_posix() for p in tree.rglob("*") if p.is_file()) == sorted(
        repo.FILES
    )


def test_an_existing_key_answers_without_reading_the_body(make_service: ServiceFactory) -> None:
    """PROTOCOL: a PUT for an existing key answers its metadata and never reads the body."""
    service = make_service()
    meta = put(service, "acme", variants=[])
    assert service.put("acme", archives.header(owner="someone-else"), Refusing()) == meta


def test_a_failed_build_leaves_the_existing_snapshot(make_service: ServiceFactory) -> None:
    """PROTOCOL: a failing build leaves any existing snapshot of the key untouched."""
    service = make_service()
    put(service, "keep", [archives.file("a.py", "a = 1\n")], variants=[])
    bad = failure(lambda: service.put("other", archives.header(), io.BytesIO(b"not a tar")))
    assert bad.code == "archive_invalid"
    assert service.store.get("other") is None
    assert (service.store.path("keep") / "tree" / "a.py").read_text() == "a = 1\n"
    assert tmp_is_empty(service)


def test_status_and_list_show_a_running_build(make_service: ServiceFactory) -> None:
    """PROTOCOL: 202 building while a build runs; list shows it; 404 for an unknown key."""
    service = make_service()
    body = Gated(archives.archive(repo.members()))
    results: list[Any] = []
    worker = threading.Thread(
        target=lambda: results.append(service.put("acme", archives.header(variants=[]), body))
    )
    worker.start()
    assert body.started.wait(30)
    status, payload = service.status("acme")
    assert (status, payload["state"]) == (202, "building")
    listing = service.list_snapshots()
    assert listing["building"] == [
        {"key": "acme", "owner": "target-1", "started_at": payload["started_at"]}
    ]
    assert service.health()["usage"]["building"] == 1
    body.release.set()
    worker.join()
    assert results[0]["key"] == "acme"
    assert failure(lambda: service.status("unknown")).code == "snapshot_missing"


def test_concurrent_puts_of_one_key_build_once(make_service: ServiceFactory) -> None:
    """PROTOCOL: a PUT while that key builds waits and answers its result; its body is unread."""
    service = make_service()
    builds: list[str] = []
    real = service.runner.build

    def counting(*arguments: Any) -> Any:
        builds.append(arguments[1])
        return real(*arguments)

    service.runner.build = counting  # type: ignore[method-assign]
    body = Gated(archives.archive(repo.members()))
    answers: list[Any] = []
    first = threading.Thread(
        target=lambda: answers.append(service.put("acme", archives.header(), body))
    )
    first.start()
    assert body.started.wait(30)
    second = threading.Thread(
        target=lambda: answers.append(service.put("acme", archives.header(), Refusing()))
    )
    second.start()
    body.release.set()
    first.join()
    second.join()
    assert answers[0] == answers[1]
    assert len(builds) == 1


def test_deleting_a_key_abandons_its_extraction(make_service: ServiceFactory) -> None:
    """PROTOCOL: a running build of a deleted key is abandoned and its result discarded."""
    service = make_service()
    body = Gated(archives.archive(repo.members()))
    errors: list[ApiError] = []

    def build() -> None:
        errors.append(failure(lambda: service.put("acme", archives.header(), body)))

    worker = threading.Thread(target=build)
    worker.start()
    assert body.started.wait(30)
    assert service.delete("acme") == {"deleted": 1}
    body.release.set()
    worker.join()
    assert (errors[0].status, errors[0].code) == (404, "snapshot_missing")
    assert service.store.get("acme") is None
    assert service.list_snapshots()["building"] == []
    assert tmp_is_empty(service)


def test_deleting_a_key_kills_its_variant_build(make_service: ServiceFactory) -> None:
    """PROTOCOL: deleting a key during its variant build kills the child and discards it."""
    service = make_service()
    service.runner._target = childtargets.sleep_forever
    errors: list[ApiError] = []
    worker = threading.Thread(target=lambda: errors.append(failure(lambda: put(service, "acme"))))
    worker.start()
    while service.runner.running == 0:
        threading.Event().wait(0.05)
    assert service.delete("acme") == {"deleted": 1}
    worker.join()
    assert errors[0].code == "snapshot_missing"
    assert service.runner.running == 0
    assert multiprocessing.active_children() == []


def test_delete_is_idempotent_and_owner_wide(make_service: ServiceFactory) -> None:
    """PROTOCOL: DELETE of a key or of an owner removes everything it names; 0 when nothing."""
    service = make_service()
    small = [archives.file("a.py", "a = 1\n")]
    put(service, "one", small, variants=[], owner="owner-a")
    put(service, "two", small, variants=[], owner="owner-a")
    put(service, "three", small, variants=[], owner="owner-b")
    assert service.delete_owner("owner-a") == {"deleted": 2}
    assert [s.key for s in service.store.all()] == ["three"]
    assert service.delete_owner("owner-a") == {"deleted": 0}
    assert service.delete("three") == {"deleted": 1}
    assert service.delete("three") == {"deleted": 0}
    assert not list(service.store.snapshots_dir.iterdir())


def test_an_owner_delete_abandons_its_running_builds(make_service: ServiceFactory) -> None:
    """PROTOCOL: DELETE /v1/owners/{owner} also abandons that owner's running builds."""
    service = make_service()
    body = Gated(archives.archive(repo.members()))
    errors: list[ApiError] = []
    worker = threading.Thread(
        target=lambda: errors.append(
            failure(lambda: service.put("acme", archives.header(owner="gone"), body))
        )
    )
    worker.start()
    assert body.started.wait(30)
    assert service.delete_owner("gone") == {"deleted": 1}
    body.release.set()
    worker.join()
    assert errors[0].code == "snapshot_missing"


@pytest.mark.parametrize(
    ("target", "code", "message"),
    [
        (childtargets.sleep_forever, "build_timeout", "the build exceeded build_timeout_s"),
        (childtargets.fail, "build_failed", "RuntimeError"),
        (childtargets.exit_silently, "build_failed", "ChildExited"),
    ],
)
def test_a_variant_that_cannot_build_fails_the_build(
    make_service: ServiceFactory, target: Any, code: str, message: str
) -> None:
    """ACT-107: a variant killed at build_timeout_s, or failing, fails the build with its counts."""
    service = make_service()
    service.runner._target = target
    error = failure(
        lambda: put(service, "acme", build_timeout_s=1, max_file_bytes=repo.MAX_FILE_BYTES)
    )
    assert (error.status, error.code, error.message) == (422, code, message)
    assert error.detail is not None
    assert error.detail["variant"] == "code"
    assert error.detail["files"] == len(repo.FILES)
    assert service.store.get("acme") is None
    assert tmp_is_empty(service)
    assert multiprocessing.active_children() == []


def test_an_on_demand_variant_that_times_out(make_service: ServiceFactory) -> None:
    """ACT-107: a variant built for a query is killed at the snapshot's build_timeout_s too."""
    service = make_service()
    put(service, "acme", variants=[], build_timeout_s=1)
    service.runner._target = childtargets.sleep_forever
    from vaultgate_code import query

    error = failure(
        lambda: query.search(
            service,
            {
                "indexes": [{"key": "acme", "label": "a"}],
                "content": ["docs"],
                "query": "billing",
                "top_k": 1,
                "max_snippet_lines": 0,
            },
        )
    )
    assert (error.code, error.detail) == ("build_timeout", {"variant": "docs"})
    assert service.store.get("acme").variants == {}  # type: ignore[union-attr]
    assert tmp_is_empty(service)


def test_health_reports_limits_and_usage(make_service: ServiceFactory, tmp_path: Path) -> None:
    """ACT-113, ACT-115: health reports the protocol, versions, limits and usage."""
    service = make_service(
        max_snapshots=3, max_storage_bytes=10 << 20, max_memory_bytes=5 << 20, build_concurrency=2
    )
    health = service.health()
    assert health["protocol"] == 1
    assert health["semble"] == "0.6.1"
    assert health["model"] == "minishlab/potion-code-16M-v2"
    assert health["model_revision"] == "e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b"
    assert health["python"].startswith("3.12.")
    assert health["limits"] == {
        "max_snapshots": 3,
        "max_storage_bytes": 10 << 20,
        "max_memory_bytes": 5 << 20,
        "build_concurrency": 2,
    }
    assert health["usage"] == {
        "snapshots": 0,
        "storage_bytes": 0,
        "loaded_variants": 0,
        "loaded_bytes": 0,
        "building": 0,
    }
    assert tmp_path.exists()
