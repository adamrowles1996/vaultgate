"""The three queries: search, related and read (PROTOCOL.md; ACT-110, ACT-111)."""

from __future__ import annotations

import os
import stat
from typing import Any

from semble.utils import resolve_chunk

from vaultgate_code import engine, indexes, validate
from vaultgate_code.errors import ApiError
from vaultgate_code.indexes import Part
from vaultgate_code.memory import Name
from vaultgate_code.rules import path_not_found, variant_name
from vaultgate_code.service import Service

DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
TEXT_PROBE_BYTES = 8192


def _parts(service: Service, request: validate.Query, snapshots: list[Any]) -> list[Part]:
    protect: set[Name] = {((key, variant_name(request.content)),) for key, _ in request.indexes}
    labels = [label for _, label in request.indexes]
    return [
        indexes.part(service, label, snapshot, request.content, protect)
        for label, snapshot in zip(labels, snapshots, strict=True)
    ]


def _answer(parts: list[Part], rendered: list[dict[str, Any]]) -> dict[str, Any]:
    """Label each result (several indexes: the prefix of its path) and list the variants used."""
    single = len(parts) == 1
    for entry in rendered:
        entry["label"] = parts[0].label if single else entry["file_path"].split("/", 1)[0]
    variants = [
        {
            "key": p.snapshot.key,
            "variant": p.variant,
            "chunks": p.info["chunks"],
            "built_at": p.info["built_at"],
        }
        for p in parts
    ]
    return {"results": rendered, "variants": variants}


def search(service: Service, body: object) -> dict[str, Any]:
    """`POST /v1/search`."""
    request = validate.search(body)
    with service.store.using(key for key, _ in request.indexes) as snapshots:
        parts = _parts(service, request, snapshots)
        index = indexes.combined(service, parts)
        results = []
        if index is not None:
            results = index.search(
                request.query,
                top_k=request.top_k,
                filter_paths=request.paths or None,
                filter_languages=request.languages or None,
                max_snippet_lines=request.max_snippet_lines,
            )
        service.store.touch(snapshots)
    return _answer(parts, engine.render(results, request.max_snippet_lines))


def related(service: Service, body: object) -> dict[str, Any]:
    """`POST /v1/related`: the chunk holding `line` (semble's rule), then `find_related`."""
    request = validate.related(body)
    with service.store.using(key for key, _ in request.indexes) as snapshots:
        parts = _parts(service, request, snapshots)
        index = indexes.combined(service, parts)
        chunk = (
            None if index is None else resolve_chunk(index.chunks, request.file_path, request.line)
        )
        if index is None or chunk is None:
            raise ApiError(404, "chunk_not_found", "no indexed chunk holds that line")
        results = index.find_related(
            chunk, top_k=request.top_k, max_snippet_lines=request.max_snippet_lines
        )
        service.store.touch(snapshots)
    return _answer(parts, engine.render(results, request.max_snippet_lines))


def read_regular(tree: str, relative: str) -> bytes:
    """Read a regular file of the tree; 404 path_not_found for anything else.

    The resolved path must stay inside the tree, and every component is also opened with
    `O_NOFOLLOW` relative to its parent, so a link planted anywhere in the tree is refused.
    """
    root = os.path.realpath(tree)
    resolved = os.path.realpath(os.path.join(root, relative))
    if os.path.commonpath([root, resolved]) != root or resolved == root:
        raise path_not_found()
    *parents, name = relative.split("/")
    try:
        directory = os.open(root, DIRECTORY_FLAGS)
        try:
            for segment in parents:
                child = os.open(segment, DIRECTORY_FLAGS, dir_fd=directory)
                os.close(directory)
                directory = child
            descriptor = os.open(name, FILE_FLAGS, dir_fd=directory)
        finally:
            os.close(directory)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise path_not_found()
            return handle.read()
    except OSError:
        raise path_not_found() from None


def read(service: Service, body: object) -> dict[str, Any]:
    """`POST /v1/read`: a line range of one file, UTF-8 with replacement characters."""
    request = validate.read(body)
    with service.store.using([request.key]) as snapshots:
        data = read_regular(str(service.store.path(request.key) / "tree"), request.file_path)
        service.store.touch(snapshots)
    if b"\x00" in data[:TEXT_PROBE_BYTES]:
        raise ApiError(422, "not_text", "the file is not text")
    lines = data.decode("utf-8", errors="replace").splitlines()
    total = len(lines)
    start = request.start_line
    if start > max(total, 1):
        raise ApiError(400, "invalid_range", "start_line is beyond the end of the file")
    end = total if request.end_line is None else min(request.end_line, total)
    last = min(end, start + request.max_lines - 1)
    return {
        "file_path": request.file_path,
        "start_line": start,
        "end_line": last,
        "total_lines": total,
        "text": "\n".join(lines[start - 1 : last]),
        "truncated": last < end,
    }
