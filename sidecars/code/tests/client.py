"""An HTTP client for the sidecar over TCP or its Unix domain socket."""

from __future__ import annotations

import http.client
import json
import socket
from typing import Any


class UnixConnection(http.client.HTTPConnection):
    """HTTP/1.1 over a Unix domain socket."""

    def __init__(self, path: str, timeout: float = 60) -> None:
        """Connect to `path` on first use."""
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        """Open the Unix domain socket."""
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


class Client:
    """One persistent connection; `call` returns (status, JSON body, headers)."""

    def __init__(self, address: str | tuple[str, int]) -> None:
        """Talk to a TCP (host, port) or a socket path."""
        self.address = address
        self.connection = self.connect()

    def connect(self) -> http.client.HTTPConnection:
        """A new connection to the same server."""
        if isinstance(self.address, str):
            return UnixConnection(self.address)
        host, port = self.address[:2]
        return http.client.HTTPConnection(host, port, timeout=60)

    def call(
        self,
        method: str,
        path: str,
        body: bytes | dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, Any, http.client.HTTPMessage]:
        """Send one request on the persistent connection."""
        sent = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            sent.setdefault("Content-Type", "application/json")
        self.connection.request(method, path, body=body, headers=sent)
        response = self.connection.getresponse()
        data = response.read()
        if response.getheader("Connection") == "close":
            self.connection.close()
            self.connection = self.connect()
        return response.status, json.loads(data), response.headers

    def post(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        """POST a JSON body; (status, body)."""
        status, payload, _ = self.call("POST", path, body)
        return status, payload

    def close(self) -> None:
        """Close the connection."""
        self.connection.close()
