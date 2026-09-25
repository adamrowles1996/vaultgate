"""The HTTP layer over a Unix domain socket and TCP: routes, codes, framing and caps."""

from __future__ import annotations

import json
import socket
from collections.abc import Callable
from typing import Any

import pytest

import archives
import childtargets
import repo
from client import Client

Serve = Callable[..., Client]
SMALL = [
    archives.file("a.py", "def invoice_total():\n    return 1\n"),
    archives.file("logo.png", b"\x00PNG"),
]
QUERY = {
    "indexes": [{"key": "acme", "label": "acme"}],
    "content": ["code"],
    "query": "invoice",
    "top_k": 3,
    "max_snippet_lines": 1,
}


def build(
    client: Client, key: str = "acme", members: list[archives.Member] | None = None, **spec: Any
) -> tuple[int, Any]:
    """PUT a snapshot."""
    status, payload, _ = client.call(
        "PUT",
        f"/v1/snapshots/{key}",
        archives.archive(SMALL if members is None else members),
        {"X-Vaultgate-Build": archives.header(**spec)},
    )
    return status, payload


@pytest.mark.parametrize("transport", ["tcp", "unix"])
def test_the_protocol_end_to_end(serve: Serve, transport: str) -> None:
    """ACT-113: every operation over each transport, on one persistent connection."""
    client = serve(transport)
    status, health, headers = client.call("GET", "/v1/health")
    assert (status, health["protocol"], headers["Content-Type"]) == (200, 1, "application/json")
    assert build(client, max_file_bytes=repo.MAX_FILE_BYTES)[0] == 200
    assert client.call("GET", "/v1/snapshots/acme")[0] == 200
    assert client.call("GET", "/v1/snapshots")[1]["snapshots"][0]["key"] == "acme"
    status, found = client.post("/v1/search", QUERY)
    assert (status, found["results"][0]["file_path"]) == (200, "a.py")
    related = {k: v for k, v in QUERY.items() if k != "query"} | {"file_path": "a.py", "line": 1}
    assert client.post("/v1/related", related)[0] == 200
    status, text = client.post("/v1/read", {"key": "acme", "file_path": "a.py", "max_lines": 1})
    assert (status, text["text"]) == (200, "def invoice_total():")
    assert client.call("DELETE", "/v1/owners/target-1")[1] == {"deleted": 1}
    assert client.call("DELETE", "/v1/snapshots/acme")[1] == {"deleted": 0}


JSON = {"Content-Type": "application/json"}
EXTRA = json.dumps({**QUERY, "extra": 1}).encode()
ABSENT = b'{"key":"absent","file_path":"a","max_lines":1}'


@pytest.mark.parametrize(
    ("call", "status", "code"),
    [
        (("GET", "/v1/nowhere"), 404, "not_found"),
        (("GET", "/v1/snapshots/a/b"), 404, "not_found"),
        (("POST", "/v1/health", b"{}"), 405, "method_not_allowed"),
        (("PATCH", "/v1/health"), 405, "method_not_allowed"),
        (("GET", "/v1/health?verbose=1"), 400, "invalid_request"),
        (("GET", "/v1/health", b"body"), 400, "invalid_request"),
        (("GET", "/v1/snapshots/UPPER"), 400, "invalid_request"),
        (("DELETE", "/v1/owners/bad_owner"), 400, "invalid_request"),
        (("DELETE", "/v1/snapshots/bad%20key"), 400, "invalid_request"),
        (("GET", "/v1/snapshots/absent"), 404, "snapshot_missing"),
        (("POST", "/v1/search", b"{", JSON), 400, "invalid_request"),
        (("POST", "/v1/search", b"[]", JSON), 400, "invalid_request"),
        (("POST", "/v1/search", b"{}", {"Content-Type": "text/plain"}), 400, "invalid_request"),
        (("POST", "/v1/search", b"{}"), 400, "invalid_request"),
        (("POST", "/v1/search", EXTRA, JSON), 400, "invalid_request"),
        (
            ("POST", "/v1/read", ABSENT, {"Content-Type": "application/json; charset=utf-8"}),
            404,
            "snapshot_missing",
        ),
        (("POST", "/v1/search", b" " * ((1 << 20) + 1), JSON), 413, "invalid_request"),
        (("PUT", "/v1/snapshots/acme", b""), 400, "invalid_request"),
        (("PUT", "/v1/snapshots/acme", b"", {"X-Vaultgate-Build": "!!"}), 400, "invalid_request"),
    ],
)
def test_request_errors(serve: Serve, call: tuple[Any, ...], status: int, code: str) -> None:
    """PROTOCOL: every error is JSON {"error", "message"}, with its status; unknown fields too."""
    client = serve()
    answer, payload, _ = client.call(*call)
    assert (answer, payload["error"]) == (status, code)
    assert isinstance(payload["message"], str)
    assert client.call("GET", "/v1/health")[0] == 200  # the server is still serving


def test_query_and_file_errors(serve: Serve) -> None:
    """PROTOCOL: invalid_path, invalid_range, path_not_found, chunk_not_found and not_text."""
    client = serve("unix")
    build(client)
    read = {"key": "acme", "max_lines": 5}
    cases = [
        ("/v1/read", read | {"file_path": "../a.py"}, 400, "invalid_path"),
        ("/v1/read", read | {"file_path": "a.py", "start_line": 9}, 400, "invalid_range"),
        ("/v1/read", read | {"file_path": "b.py"}, 404, "path_not_found"),
        ("/v1/read", read | {"file_path": "logo.png"}, 422, "not_text"),
        (
            "/v1/related",
            {k: v for k, v in QUERY.items() if k != "query"} | {"file_path": "a.py", "line": 99},
            404,
            "chunk_not_found",
        ),
    ]
    for path, body, status, code in cases:
        answer, payload = client.post(path, body)
        assert (answer, payload["error"]) == (status, code)


@pytest.mark.parametrize(
    ("members", "spec", "code"),
    [
        ([archives.file("../x", "x")], {}, "archive_invalid"),
        (
            [archives.file("a.txt", "12345")],
            {"max_total_bytes": 3, "max_file_bytes": 10},
            "archive_too_large",
        ),
    ],
)
def test_archive_errors_carry_counts(
    serve: Serve, members: list[archives.Member], spec: dict[str, Any], code: str
) -> None:
    """PROTOCOL: 422 archive_invalid and archive_too_large with detail holding the counts."""
    client = serve()
    status, payload = build(client, members=members, **spec)
    assert (status, payload["error"]) == (422, code)
    assert set(payload["detail"]) == {"members", "files", "bytes", "skipped"}


def test_build_errors_and_storage_full(serve: Serve) -> None:
    """PROTOCOL: 422 build_timeout and build_failed, 507 storage_full."""
    client = serve()
    runner = client.app.service.runner  # type: ignore[attr-defined]
    runner._target = childtargets.sleep_forever
    assert build(client, build_timeout_s=1)[1]["error"] == "build_timeout"
    runner._target = childtargets.fail
    assert build(client)[1]["error"] == "build_failed"
    client.app.service.store.max_storage_bytes = 10  # type: ignore[attr-defined]
    status, payload = build(client, variants=[])
    assert (status, payload["error"]) == (507, "storage_full")


def test_an_unexpected_failure_is_a_bare_500(serve: Serve, monkeypatch: pytest.MonkeyPatch) -> None:
    """PROTOCOL: an internal failure answers 500 internal_error with no detail."""
    client = serve()

    def broken() -> None:
        raise KeyError("/secret/path/in/a/message")

    monkeypatch.setattr(client.app.service, "health", broken)  # type: ignore[attr-defined]
    status, payload, _ = client.call("GET", "/v1/health")
    assert (status, payload) == (500, {"error": "internal_error", "message": "KeyError"})


def test_a_put_for_an_existing_key_closes_without_reading(serve: Serve) -> None:
    """PROTOCOL: an existing key answers 200 at once; the unread body closes the connection."""
    client = serve()
    assert build(client)[0] == 200
    status, _, headers = client.call(
        "PUT", "/v1/snapshots/acme", b"x" * 100_000, {"X-Vaultgate-Build": archives.header()}
    )
    assert (status, headers["Connection"]) == (200, "close")
    assert client.call("GET", "/v1/health")[0] == 200


def test_chunked_bodies_are_accepted(serve: Serve) -> None:
    """PROTOCOL: the archive and JSON bodies may be chunked."""
    client = serve()
    data = archives.archive(SMALL)
    connection = client.connect()
    connection.request(
        "PUT",
        "/v1/snapshots/acme",
        body=iter([data[:100], data[100:]]),
        headers={"X-Vaultgate-Build": archives.header()},
        encode_chunked=True,
    )
    response = connection.getresponse()
    assert (response.status, json.loads(response.read())["files"]) == (200, 2)
    connection.request(
        "POST",
        "/v1/search",
        body=iter([json.dumps(QUERY).encode()]),
        headers={"Content-Type": "application/json"},
        encode_chunked=True,
    )
    response = connection.getresponse()
    assert response.status == 200
    assert json.loads(response.read())["results"]
    connection.close()


def raw_exchange(client: Client, request: bytes) -> bytes:
    """Send raw bytes, read until the server closes."""
    address = client.address
    family = socket.AF_UNIX if isinstance(address, str) else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(30)
        sock.connect(address)
        sock.sendall(request)
        received = b""
        while chunk := sock.recv(65536):
            received += chunk
    return received


@pytest.mark.parametrize(
    ("request_bytes", "status"),
    [
        (b"NOT A REQUEST\r\n\r\n", 400),
        (b"GET /" + b"a" * 70_000 + b" HTTP/1.1\r\n\r\n", 414),
        (b"GET /v1/health HTTP/1.1\r\nX-Long: " + b"a" * 70_000 + b"\r\n\r\n", 431),
        (b"BREW /v1/health HTTP/1.1\r\nHost: x\r\n\r\n", 405),
        (
            b"POST /v1/search HTTP/1.1\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n",
            400,
        ),
    ],
)
def test_framing_errors_are_json_too(serve: Serve, request_bytes: bytes, status: int) -> None:
    """PROTOCOL: errors http.server raises itself are JSON as well, and close the connection."""
    received = raw_exchange(serve(), request_bytes)
    head, _, body = received.partition(b"\r\n\r\n")
    assert head.startswith(f"HTTP/1.1 {status} ".encode())
    assert b"Connection: close" in head
    assert json.loads(body)["error"] in {"invalid_request", "method_not_allowed"}


def test_a_client_that_leaves_early_does_not_break_the_server(serve: Serve) -> None:
    """PROTOCOL: a client closing before the answer costs nothing but its own request."""
    client = serve()
    family = socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")
        sock.connect(client.address)
        sock.sendall(b"GET /v1/health HTTP/1.1\r\nHost: x\r\n\r\n")
    assert client.call("GET", "/v1/health")[0] == 200
