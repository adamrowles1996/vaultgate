"""Request bodies that record, gate or refuse reads."""

from __future__ import annotations

import threading


class Gated:
    """Serves `data` in pieces; stops after the first piece until `release` is set."""

    def __init__(self, data: bytes, piece: int = 512) -> None:
        """Hold `data`."""
        self._data = data
        self._piece = piece
        self._offset = 0
        self.started = threading.Event()
        self.release = threading.Event()

    def read(self, size: int = -1, /) -> bytes:
        """Return the next piece, waiting for `release` after the first."""
        if self._offset:
            self.started.set()
            assert self.release.wait(60)
        wanted = self._piece if size < 0 else min(size, self._piece)
        chunk = self._data[self._offset : self._offset + wanted]
        self._offset += len(chunk)
        return chunk


class Refusing:
    """A body that must never be read."""

    def read(self, size: int = -1, /) -> bytes:
        """Fail the test."""
        raise AssertionError("this body must not be read")
