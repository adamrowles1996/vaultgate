"""Request body framing: Content-Length or chunked, read as a stream (PROTOCOL.md)."""

from __future__ import annotations

import io
from email.message import Message
from typing import Any

import pytest

from vaultgate_code.errors import ApiError
from vaultgate_code.httpio import MAX_JSON_BYTES, Body
from vaultgate_code.server import Handler


def headers(**values: str) -> Message:
    """Request headers, `_` in a name standing for `-`."""
    message = Message()
    for name, value in values.items():
        message[name.replace("_", "-")] = value
    return message


def body(data: bytes, **values: str) -> Body:
    """A body over `data`."""
    return Body(io.BytesIO(data), headers(**values))


def refused(call: Any) -> str:
    """The message of the 400 invalid_request the call raises."""
    with pytest.raises(ApiError) as caught:
        call()
    assert (caught.value.status, caught.value.code) == (400, "invalid_request")
    return caught.value.message


class Broken:
    """A connection that fails every read."""

    def read(self, _size: int = -1, /) -> bytes:
        """Fail."""
        raise ConnectionResetError

    def readline(self, _size: int = -1, /) -> bytes:
        """Fail."""
        raise ConnectionResetError


def test_content_length_bodies() -> None:
    """ACT-113: a Content-Length body is read in pieces, and completes at its length."""
    framed = body(b"hello world, and more", Content_Length="11")
    assert (framed.read(5), framed.read(), framed.read(3)) == (b"hello", b" world", b"")
    assert framed.complete
    assert not framed.empty
    assert body(b"").empty
    assert body(b"", Content_Length="0").read() == b""


def test_chunked_bodies_with_extensions_and_trailers() -> None:
    """ACT-105: a chunked body, with chunk extensions and trailers, reads as its data."""
    data = b"5;name=value\r\nhello\r\n1\r\n \r\n5\r\nworld\r\n0\r\nX-Trailer: 1\r\n\r\n"
    framed = body(data, Transfer_Encoding="chunked")
    assert not framed.empty
    assert framed.read_json() == b"hello world"
    assert framed.complete


@pytest.mark.parametrize(
    ("values", "message"),
    [
        ({"Content_Length": "5", "Transfer_Encoding": "chunked"}, "not have both"),
        ({"Transfer_Encoding": "gzip"}, "the only transfer encoding accepted is chunked"),
        ({"Content_Length": "-1"}, "Content-Length is malformed"),
        ({"Content_Length": "1e3"}, "Content-Length is malformed"),
    ],
)
def test_ambiguous_framing_is_refused(values: dict[str, str], message: str) -> None:
    """ACT-113: two framings, another transfer encoding or a bad length is invalid_request."""
    assert message in refused(lambda: body(b"", **values))


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"5\r\n123", "ended early"),
        (b"5\r\nhelloXX0\r\n\r\n", "chunked body is malformed"),
        (b"zz\r\nhello\r\n", "chunked body is malformed"),
        (b"5\nhello\r\n", "chunked body is malformed"),
        (b"5" * 2000 + b"\r\n", "chunked body is malformed"),
        (b"", "chunked body is malformed"),
    ],
)
def test_malformed_chunked_bodies(data: bytes, message: str) -> None:
    """ACT-113: a chunked body that is cut short or garbled is invalid_request."""
    framed = body(data, Transfer_Encoding="chunked")
    assert message in refused(framed.read_json)


def test_a_connection_that_fails_mid_body() -> None:
    """ACT-113: a body the connection cannot deliver is invalid_request."""
    length = Body(Broken(), headers(Content_Length="10"))
    assert "could not be read" in refused(lambda: length.read(10))
    chunked = Body(Broken(), headers(Transfer_Encoding="chunked"))
    assert "could not be read" in refused(lambda: chunked.read(10))


def test_json_bodies_are_capped_at_1_mib() -> None:
    """ACT-113: a JSON body over 1 MiB is 413."""
    assert body(b"x" * MAX_JSON_BYTES, Content_Length=str(MAX_JSON_BYTES)).read_json()
    over = body(b"x" * (MAX_JSON_BYTES + 1), Content_Length=str(MAX_JSON_BYTES + 1))
    with pytest.raises(ApiError) as caught:
        over.read_json()
    assert (caught.value.status, caught.value.code) == (413, "invalid_request")


def test_lingering_on_a_connection_already_gone() -> None:
    """ACT-113: closing after an unread body tolerates a client that has already left."""

    class Gone:
        def shutdown(self, _how: int) -> None:
            raise BrokenPipeError

    handler = object.__new__(Handler)
    handler.connection = Gone()
    handler._linger()
