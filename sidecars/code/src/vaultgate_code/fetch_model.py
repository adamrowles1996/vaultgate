"""Fetch and verify the pinned embedding model, with the Python standard library alone.

    python3 -m vaultgate_code.fetch_model --dest DIR [--verify-only]

`model.json` pins the model to a Hugging Face commit and lists every file the sidecar loads
with its size and SHA-256. Each file is downloaded at that commit over HTTPS, checked while it
streams (a byte beyond the pinned size stops it) and renamed into place only when it matches.
The image build, CI and the bare-metal installer use this; the server calls `verify_dir` at
start-up and refuses to serve from a directory that does not hold exactly these files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import IO, Any

CHUNK_BYTES = 1 << 20
TIMEOUT_S = 60


class ModelError(Exception):
    """The model directory or a download does not match the pinned model."""


@dataclass(frozen=True)
class ModelFile:
    """One pinned file of the model."""

    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class Manifest:
    """The pinned model: its id, its Hugging Face revision and its files."""

    model: str
    revision: str
    url: str
    files: tuple[ModelFile, ...]

    def url_for(self, entry: ModelFile) -> str:
        """Return the download URL of one file at the pinned revision."""
        return self.url.format(model=self.model, revision=self.revision, path=entry.path)


def load_manifest() -> Manifest:
    """Read `model.json`, which ships inside the package."""
    text = resources.files("vaultgate_code").joinpath("model.json").read_text(encoding="utf-8")
    data = json.loads(text)
    files = tuple(ModelFile(**entry) for entry in data["files"])
    return Manifest(data["model"], data["revision"], data["url"], files)


def _digest(stream: IO[bytes], expected: ModelFile, sink: IO[bytes] | None = None) -> None:
    """Hash a stream (copying it to `sink`), refusing anything but the pinned size and digest."""
    digest = hashlib.sha256()
    size = 0
    while chunk := stream.read(CHUNK_BYTES):
        size += len(chunk)
        if size > expected.size:
            raise ModelError(f"{expected.path} is larger than the pinned file")
        digest.update(chunk)
        if sink is not None:
            sink.write(chunk)
    if size != expected.size or digest.hexdigest() != expected.sha256:
        raise ModelError(f"{expected.path} does not match the pinned SHA-256")


def verify_file(path: Path, expected: ModelFile) -> None:
    """Check one file: a regular file (never a link) of the pinned size and SHA-256.

    The descriptor is checked before it is wrapped: a directory cannot be wrapped for reading,
    and `O_NONBLOCK` keeps a FIFO planted in the model's place from blocking the open.
    """
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ModelError(f"{expected.path} cannot be opened: {error.strerror}") from None
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise ModelError(f"{expected.path} is not a regular file")
    with os.fdopen(descriptor, "rb") as handle:
        _digest(handle, expected)


def verify_dir(directory: Path, manifest: Manifest | None = None) -> Manifest:
    """Check that `directory` holds exactly the pinned files, each matching its digest."""
    pinned = manifest or load_manifest()
    try:
        names = sorted(os.listdir(directory))
    except OSError as error:
        raise ModelError(f"the model directory cannot be read: {error.strerror}") from None
    if names != sorted(entry.path for entry in pinned.files):
        raise ModelError("the model directory holds other files than the pinned model's")
    for entry in pinned.files:
        verify_file(directory / entry.path, entry)
    return pinned


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another HTTPS URL (the Hub sends large files to its CDN)."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        """Refuse a redirect that leaves HTTPS."""
        if not newurl.startswith("https://"):
            raise ModelError("refusing a redirect away from HTTPS")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


Opener = Callable[[str], IO[bytes]]


def https_open(url: str) -> IO[bytes]:
    """Open an HTTPS URL, following HTTPS redirects only."""
    if not url.startswith("https://"):
        raise ModelError("the model is fetched over HTTPS only")
    opener = urllib.request.build_opener(_HttpsOnlyRedirects)
    agent = {"User-Agent": "vaultgate-code-fetch-model"}
    request = urllib.request.Request(url, headers=agent)  # noqa: S310 - checked HTTPS above
    response: IO[bytes] = opener.open(request, timeout=TIMEOUT_S)
    return response


def _download(url: str, target: Path, expected: ModelFile, opener: Opener) -> None:
    """Stream one file into a temporary name beside `target` and rename it once it matches."""
    partial = target.with_name(f".{target.name}.partial")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        with os.fdopen(os.open(partial, flags, 0o644), "wb") as sink, opener(url) as response:
            _digest(response, expected, sink)
            sink.flush()
            os.fsync(sink.fileno())
            os.fchmod(sink.fileno(), 0o644)
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)


def fetch(dest: Path, manifest: Manifest | None = None, opener: Opener = https_open) -> Manifest:
    """Download every pinned file that `dest` does not already hold intact, then verify it."""
    pinned = manifest or load_manifest()
    dest.mkdir(mode=0o755, parents=True, exist_ok=True)
    for entry in pinned.files:
        target = dest / entry.path
        try:
            verify_file(target, entry)
        except ModelError:
            _download(pinned.url_for(entry), target, entry, opener)
    return verify_dir(dest, pinned)


def main(argv: list[str] | None = None) -> int:
    """Run the command line; 0 once the directory holds the verified model."""
    parser = argparse.ArgumentParser(
        prog="python3 -m vaultgate_code.fetch_model",
        description="Download the pinned embedding model and verify every file's SHA-256.",
    )
    parser.add_argument("--dest", required=True, type=Path, help="the model directory")
    parser.add_argument(
        "--verify-only", action="store_true", help="check the directory, download nothing"
    )
    args = parser.parse_args(argv)
    try:
        pinned = verify_dir(args.dest) if args.verify_only else fetch(args.dest)
    except (ModelError, OSError) as error:
        sys.stderr.write(f"fetch_model: {error}\n")
        return 1
    sys.stdout.write(f"{pinned.model}@{pinned.revision} verified in {args.dest}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
