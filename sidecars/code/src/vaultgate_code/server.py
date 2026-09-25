"""HTTP/1.1 over a Unix domain socket or TCP, with the standard library's server."""

from __future__ import annotations

import json
import re
import socket
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler
from typing import Any, ClassVar

from vaultgate_code import logs, query, rules
from vaultgate_code.errors import ApiError, invalid_request
from vaultgate_code.httpio import Body
from vaultgate_code.service import Service
from vaultgate_code.validate import parse_json

LINGER_S = 2.0
LINGER_TOTAL_S = 30.0
Reply = tuple[int, dict[str, Any], dict[str, Any]]  # status, body, log fields
Route = Callable[["Handler", Body, str], Reply]


def _health(handler: Handler, _body: Body, _arg: str) -> Reply:
    return 200, handler.service.health(), {}


def _list(handler: Handler, _body: Body, _arg: str) -> Reply:
    return 200, handler.service.list_snapshots(), {}


def _status(handler: Handler, _body: Body, key: str) -> Reply:
    status, payload = handler.service.status(key)
    return status, payload, {"key": key}


def _build(handler: Handler, body: Body, key: str) -> Reply:
    header = handler.headers.get("X-Vaultgate-Build")
    return 200, handler.service.put(key, header, body), {"key": key}


def _delete(handler: Handler, _body: Body, key: str) -> Reply:
    return 200, handler.service.delete(key), {"key": key}


def _delete_owner(handler: Handler, _body: Body, owner: str) -> Reply:
    return 200, handler.service.delete_owner(owner), {"owner": owner}


def _query(operation: Callable[[Service, object], dict[str, Any]]) -> Route:
    def route(handler: Handler, body: Body, _arg: str) -> Reply:
        media = (handler.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if media != "application/json":
            raise invalid_request("the body must be application/json")
        request = parse_json(body.read_json())
        keys = _keys(request)
        return 200, operation(handler.service, request), {"keys": keys} if keys else {}

    return route


def _keys(request: object) -> list[str]:
    """The snapshot keys a query names, for the log line (only well-formed ones)."""
    if not isinstance(request, dict):
        return []
    indexes = request.get("indexes")
    entries = indexes if isinstance(indexes, list) else []
    named = [request.get("key")] + [e.get("key") for e in entries if isinstance(e, dict)]
    return [k for k in named if isinstance(k, str) and rules.KEY.fullmatch(k)]


ROUTES: list[tuple[re.Pattern[str], dict[str, tuple[str, Route]]]] = [
    (re.compile(r"/v1/health"), {"GET": ("health", _health)}),
    (re.compile(r"/v1/snapshots"), {"GET": ("list", _list)}),
    (
        re.compile(r"/v1/snapshots/([^/]*)"),
        {"GET": ("status", _status), "PUT": ("build", _build), "DELETE": ("delete", _delete)},
    ),
    (re.compile(r"/v1/owners/([^/]*)"), {"DELETE": ("delete_owner", _delete_owner)}),
    (re.compile(r"/v1/search"), {"POST": ("search", _query(query.search))}),
    (re.compile(r"/v1/related"), {"POST": ("related", _query(query.related))}),
    (re.compile(r"/v1/read"), {"POST": ("read", _query(query.read))}),
]


class Handler(BaseHTTPRequestHandler):
    """One connection; every response is JSON, every request a line in the log."""

    protocol_version = "HTTP/1.1"
    server_version = "vaultgate-code"
    sys_version = ""
    timeout = 300  # seconds a connection may sit idle mid-request
    service: ClassVar[Service]

    def do_GET(self) -> None:
        """GET."""
        self._handle()

    def do_PUT(self) -> None:
        """PUT."""
        self._handle()

    def do_POST(self) -> None:
        """POST."""
        self._handle()

    def do_DELETE(self) -> None:
        """DELETE."""
        self._handle()

    def _resolve(self, body: Body) -> tuple[str, Route, str]:
        path, _, parameters = self.path.partition("?")
        for pattern, methods in ROUTES:
            match = pattern.fullmatch(path)
            if match is None:
                continue
            if self.command not in methods:
                allowed = ", ".join(sorted(methods))
                raise ApiError(405, "method_not_allowed", f"allowed: {allowed}")
            op, route = methods[self.command]
            if parameters:
                raise invalid_request("query parameters are not accepted")
            if self.command in {"GET", "DELETE"} and not body.empty:
                raise invalid_request("this operation takes no body")
            return op, route, match.group(1) if match.groups() else ""
        raise ApiError(404, "not_found", "no such operation")

    def _handle(self) -> None:
        started = time.monotonic()
        op, fields = "unknown", dict[str, Any]()
        body: Body | None = None
        try:
            body = Body(self.rfile, self.headers)
            op, route, argument = self._resolve(body)
            status, payload, fields = route(self, body, argument)
        except ApiError as error:
            status, payload = error.status, error.body()
        except Exception as error:  # noqa: BLE001 - answered as a 500 without detail
            status, payload = 500, {"error": "internal_error", "message": type(error).__name__}
        self._respond(status, payload, unread=body is None or not body.complete)
        logs.event(
            "request",
            op=op,
            status=status,
            outcome=payload.get("error", "ok"),
            duration_ms=round((time.monotonic() - started) * 1000),
            **fields,
        )

    def _respond(self, status: int, payload: dict[str, Any], *, unread: bool) -> None:
        data = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("ascii")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if unread:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
        except OSError:
            self.close_connection = True
            return
        if unread:
            self._linger()

    def _linger(self) -> None:
        """Close gracefully with the body unread.

        Stop writing, then discard what still arrives for a while, so the client reads the
        response rather than a connection reset.
        """
        try:
            self.connection.shutdown(socket.SHUT_WR)
            self.connection.settimeout(LINGER_S)
            deadline = time.monotonic() + LINGER_TOTAL_S
            while time.monotonic() < deadline and self.connection.recv(1 << 16):
                pass
        except OSError:
            return

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """Framing errors of http.server itself, answered as JSON like everything else."""
        del message, explain
        self.request_version = self.protocol_version  # a status line even for "HTTP/0.9" garbage
        if code == 501:  # noqa: PLR2004 - an unsupported method
            status, error = 405, "method_not_allowed"
        else:
            status, error = code, "invalid_request"
        self._respond(status, {"error": error, "message": "the request is malformed"}, unread=True)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Silenced: the sidecar logs one JSON line per request instead."""
