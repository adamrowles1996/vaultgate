"""The tree-sitter grammars `semble` chunks with, prepared ahead of time and only read at run time.

    python3 -m vaultgate_code.grammars --dest DIR [--verify-only]

`semble` 0.6.1 splits source into chunks along its syntax tree with the grammars of
`semble-grammars`. That package ships every grammar's shared library in an archive inside its
wheel and, the first time a language is asked for, extracts the library into a cache directory
(`$SEMBLE_GRAMMARS_CACHE_DIR`, else below `$XDG_CACHE_HOME`) and loads it from there. The
sidecar's own environment points every cache below `/dev/null`, where the extraction fails, and
`semble` then falls back to chunking by lines without a word.

So the grammars are extracted once, before the sidecar runs (the image build, the installer, the
test session), into DIR: `DIR/<platform>/<library>`, every library `semble-grammars` bundles for
this platform, extracted with the package's own checked extraction and written `0755` (the
directories too). Then each is verified: a regular file, never a link, with the SHA-256 of the
package's manifest, loading as a tree-sitter language. `serve --grammars DIR` verifies DIR the
same way at start-up, refuses to start if anything is amiss, and points `semble-grammars` at it
(`SEMBLE_GRAMMARS_CACHE_DIR`, inherited by every build child). Every library is then already in
place, so the package reads DIR and never writes to it: DIR can be read-only.

The standard library and `semble-grammars` only; nothing is downloaded (the archive is in the
wheel). The package's manifest and platform tag are read from `semble_grammars.loader`, which is
why `semble-grammars` is pinned to the version below.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import os
import shutil
import stat
import sys
import tarfile
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from importlib import resources
from pathlib import Path

import semble_grammars
from semble_grammars import loader
from semble_grammars.cache import extract_atomic

VERSION = "0.1.2"
ENV = "SEMBLE_GRAMMARS_CACHE_DIR"
CHUNK_BYTES = 1 << 20


class GrammarsError(Exception):
    """The grammars directory, or the bundled archive, does not hold what the manifest pins."""


@dataclass(frozen=True)
class Grammar:
    """One bundled grammar: its language, its library's file name and its SHA-256."""

    language: str
    file: str
    sha256: str


@dataclass(frozen=True)
class Bundle:
    """What `semble-grammars` bundles for this platform, as its manifest lists it."""

    version: str
    platform: str
    archive: Path
    grammars: tuple[Grammar, ...]


def load_bundle(version: str = semble_grammars.__version__) -> Bundle:
    """Read the package's manifest for this platform; refuse another version or platform."""
    if version != VERSION:
        raise GrammarsError(f"semble-grammars {VERSION} is required, found {version}")
    try:
        manifest = loader._platform_manifest()  # noqa: SLF001 - the pinned version's manifest
    except semble_grammars.UnsupportedPlatformError:
        raise GrammarsError("semble-grammars bundles no grammars for this platform") from None
    platform = manifest["platform"]
    archive = resources.files("semble_grammars") / "grammars" / platform / manifest["archive"]
    grammars = tuple(
        Grammar(language, entry["file"], entry["sha256"])
        for language, entry in sorted(manifest["languages"].items())
    )
    return Bundle(version, platform, Path(str(archive)), grammars)


def verify_file(path: Path, grammar: Grammar) -> None:
    """Check one library: a regular file (never a link) with the manifest's SHA-256.

    As `fetch_model.verify_file` does, the descriptor is checked before it is wrapped, and
    `O_NONBLOCK` keeps a FIFO planted in a library's place from blocking the open.
    """
    name = f"grammar {grammar.language} ({grammar.file})"
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        problem = "is a symbolic link" if error.errno == errno.ELOOP else "cannot be opened"
        raise GrammarsError(f"{name} {problem}") from None
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise GrammarsError(f"{name} is not a regular file")
    digest = hashlib.sha256()
    with os.fdopen(descriptor, "rb") as handle:
        while chunk := handle.read(CHUNK_BYTES):
            digest.update(chunk)
    if digest.hexdigest() != grammar.sha256:
        raise GrammarsError(f"{name} does not match the pinned SHA-256")


@contextmanager
def _pointed_at(directory: Path) -> Iterator[None]:
    """`SEMBLE_GRAMMARS_CACHE_DIR` set to `directory` for a while, then as it was."""
    previous = os.environ.get(ENV)
    os.environ[ENV] = str(directory)
    try:
        yield
    finally:
        if previous is None:
            del os.environ[ENV]
        else:
            os.environ[ENV] = previous


def _load_every(directory: Path, bundle: Bundle) -> None:
    """Load every grammar from `directory` as `semble` will, afresh (the package caches loads)."""
    semble_grammars.get_language.cache_clear()
    with _pointed_at(directory):
        for grammar in bundle.grammars:
            try:
                semble_grammars.get_language(grammar.language)
            except (semble_grammars.GrammarLoadError, ValueError) as error:
                name = type(error).__name__
                raise GrammarsError(f"grammar {grammar.language} does not load: {name}") from None


def verify_dir(directory: Path, bundle: Bundle | None = None) -> Bundle:
    """Check that `directory` holds every bundled grammar intact, and that each one loads."""
    pinned = bundle or load_bundle()
    absolute = Path(os.path.abspath(directory))
    platform_dir = absolute / pinned.platform
    try:
        mode = os.lstat(platform_dir).st_mode
    except OSError as error:
        raise GrammarsError(f"the grammars directory cannot be read: {error.strerror}") from None
    if not stat.S_ISDIR(mode):
        raise GrammarsError(f"the grammars directory's {pinned.platform} is not a directory")
    for grammar in pinned.grammars:
        verify_file(platform_dir / grammar.file, grammar)
    _load_every(absolute, pinned)
    return pinned


def extract(dest: Path, bundle: Bundle | None = None) -> Bundle:
    """Extract every grammar that `dest` does not already hold intact, then verify `dest`.

    Each library is extracted by `semble-grammars` (a temporary file, checked against the
    manifest's SHA-256, made `0755`) into a staging directory beside its place, then renamed over
    whatever was there, a link included. Nothing else in `dest` is touched.
    """
    pinned = bundle or load_bundle()
    platform_dir = dest / pinned.platform
    for directory in (dest, platform_dir):
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        os.chmod(directory, 0o755)  # noqa: S103 - read by the server's user, written by none
    wanted = []
    for grammar in pinned.grammars:
        try:
            verify_file(platform_dir / grammar.file, grammar)
        except GrammarsError:
            wanted.append(grammar)
    if wanted:
        staging = Path(tempfile.mkdtemp(prefix=".extract-", dir=platform_dir))
        try:
            for grammar in wanted:
                _extract_one(pinned, grammar, staging, platform_dir)
        finally:
            shutil.rmtree(staging)
    return verify_dir(dest, pinned)


def _extract_one(bundle: Bundle, grammar: Grammar, staging: Path, platform_dir: Path) -> None:
    staged = staging / grammar.file
    try:
        extract_atomic(bundle.archive, grammar.file, staged, grammar.sha256)
    except (KeyError, tarfile.TarError, ValueError) as error:
        name = type(error).__name__
        raise GrammarsError(f"grammar {grammar.language} cannot be extracted: {name}") from None
    os.replace(staged, platform_dir / grammar.file)


def use(directory: Path) -> Bundle:
    """Verify `directory`, then point `semble-grammars` at it here and in every child started."""
    absolute = Path(os.path.abspath(directory))
    bundle = verify_dir(absolute)
    os.environ[ENV] = str(absolute)
    return bundle


def main(argv: list[str] | None = None) -> int:
    """Run the command line; 0 once the directory holds every grammar, verified."""
    parser = argparse.ArgumentParser(
        prog="python3 -m vaultgate_code.grammars",
        description=(
            "Extract the tree-sitter grammars semble chunks with, and verify each one's SHA-256 "
            "and that it loads."
        ),
    )
    parser.add_argument("--dest", required=True, type=Path, help="the grammars directory")
    parser.add_argument(
        "--verify-only", action="store_true", help="check the directory, write nothing"
    )
    args = parser.parse_args(argv)
    try:
        bundle = verify_dir(args.dest) if args.verify_only else extract(args.dest)
    except (GrammarsError, OSError) as error:
        sys.stderr.write(f"grammars: {error}\n")
        return 1
    count, platform = len(bundle.grammars), bundle.platform
    sys.stdout.write(f"semble-grammars {bundle.version}: {count} {platform} grammars verified\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
