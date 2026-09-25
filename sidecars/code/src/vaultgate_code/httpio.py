"""Request bodies: `Content-Length` or `chunked`, read as a stream, never both at once."""

from __future__ import annotations

import re
from email.message import Message
from typing import Protocol

from vaultgate_code.errors import invalid_request

MAX_JSON_BYTES = 1 << 20
MAX_CHUNK_LINE = 1024
READ_BYTES = 1 << 16
CHUNK_SIZE = re.compile(rb"[0-9A-Fa-f]{1,15}")


def _digits(value: str) -> bool:
    return value.isascii() and value.isdigit()


class Stream(Protocol):
    """The connection's buffered reader."""

    def read(self, size: int = -1, /) -> bytes:
        """Read up to `size` bytes."""
        ...

    def readline(self, size: int = -1, /) -> bytes:
        """Read one line of at most `size` bytes."""
        ...


class Body:
    """The body of one request, read incrementally; `complete` once all of it was read."""

    def __init__(self, stream: Stream, headers: Message) -> None:
        """Choose the framing; 400 invalid_request for an ambiguous or unsupported one."""
        self._stream = stream
        encoding = headers.get("Transfer-Encoding")
        length = headers.get("Content-Length")
        if encoding is not None and length is not None:
            raise invalid_request(
                "a request may not have both Content-Length and Transfer-Encoding"
            )
        self._chunked = encoding is not None
        if encoding is not None and encoding.strip().lower() != "chunked":
            raise invalid_request("the only transfer encoding accepted is chunked")
        if length is not None and not _digits(length.strip()):
            raise invalid_request("Content-Length is malformed")
        self._remaining = 0 if length is None else int(length)
        self.complete = not self._chunked and self._remaining == 0

    @property
    def empty(self) -> bool:
        """True when the request declared no body at all."""
        return self.complete and not self._chunked

    def _read_exact(self, size: int) -> bytes:
        try:
            data = self._stream.read(size)
        except OSError:
            raise invalid_request("the request body could not be read") from None
        if len(data) < size:
            raise invalid_request("the request body ended early")
        return data

    def _line(self) -> bytes:
        try:
            line = self._stream.readline(MAX_CHUNK_LINE + 1)
        except OSError:
            raise invalid_request("the request body could not be read") from None
        if not line.endswith(b"\r\n"):
            raise invalid_request("the chunked body is malformed")
        return line[:-2]

    def _next_chunk(self) -> None:
        size_text = self._line().split(b";", 1)[0].strip()
        if CHUNK_SIZE.fullmatch(size_text) is None:
            raise invalid_request("the chunked body is malformed")
        size = int(size_text, 16)
        if size == 0:
            while self._line():  # trailers, up to the empty line
                pass
            self.complete = True
        self._remaining = size

    def read(self, size: int = -1, /) -> bytes:
        """Return up to `size` bytes (the rest of the current chunk when negative)."""
        if self._chunked and not self.complete and self._remaining == 0:
            self._next_chunk()
        if self.complete:
            return b""
        wanted = self._remaining if size < 0 else min(size, self._remaining)
        data = self._read_exact(wanted)
        self._remaining -= len(data)
        if self._remaining == 0:
            if self._chunked:
                if self._read_exact(2) != b"\r\n":
                    raise invalid_request("the chunked body is malformed")
            else:
                self.complete = True
        return data

    def read_json(self) -> bytes:
        """The whole body, at most 1 MiB (413 beyond)."""
        parts: list[bytes] = []
        total = 0
        while chunk := self.read(READ_BYTES):
            total += len(chunk)
            if total > MAX_JSON_BYTES:
                error = invalid_request("the request body exceeds 1 MiB")
                error.status = 413
                raise error
            parts.append(chunk)
        return b"".join(parts)
