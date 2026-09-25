"""The protocol's errors: a status, a code and a message that never carries content."""

from __future__ import annotations

from typing import Any


class ApiError(Exception):
    """An error answered as `{"error": code, "message": text, "detail"?: {...}}`."""

    def __init__(
        self, status: int, code: str, message: str, detail: dict[str, Any] | None = None
    ) -> None:
        """Record the status, the code, a content-free message and optional detail."""
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail

    def body(self) -> dict[str, Any]:
        """Return the JSON body."""
        body: dict[str, Any] = {"error": self.code, "message": self.message}
        if self.detail is not None:
            body["detail"] = self.detail
        return body


def invalid_request(message: str) -> ApiError:
    """400: a malformed request."""
    return ApiError(400, "invalid_request", message)


def invalid_path(message: str) -> ApiError:
    """400: a path argument that breaks the path rules."""
    return ApiError(400, "invalid_path", message)


def snapshot_missing(key: str) -> ApiError:
    """404: no snapshot has that key."""
    return ApiError(404, "snapshot_missing", "no snapshot has that key", {"key": key})


def storage_full() -> ApiError:
    """507: the snapshot cannot fit within the disk caps."""
    return ApiError(507, "storage_full", "the snapshot does not fit within the storage caps")
