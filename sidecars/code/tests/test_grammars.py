"""The grammars directory (ACT-113): extracted once, then every library verified and loaded.

`python3 -m vaultgate_code.grammars --dest DIR [--verify-only]` extracts what `semble-grammars`
bundles for this platform and verifies it; `serve` verifies the same way at start-up.
"""

from __future__ import annotations

import dataclasses
import os
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import semble_grammars
from semble_grammars import loader
from semble_grammars.cache import cache_dir

from vaultgate_code import grammars
from vaultgate_code.grammars import Bundle, GrammarsError

SRC = Path(__file__).resolve().parents[1] / "src"
PYTHON = "libtree_sitter_python.so"


def copy_of(source: Path, tmp_path: Path) -> Path:
    """A copy of a grammars directory to damage."""
    return Path(shutil.copytree(source, tmp_path / "grammars", symlinks=True))


def library(directory: Path, bundle: Bundle, name: str = PYTHON) -> Path:
    """One library's path in a grammars directory."""
    return directory / bundle.platform / name


def listing(directory: Path) -> list[tuple[str, int, int, int]]:
    """Every entry below `directory`: its path, mode, size and modification time."""
    entries = []
    for path in sorted(directory.rglob("*")):
        status = os.lstat(path)
        entries.append((str(path), status.st_mode, status.st_size, status.st_mtime_ns))
    return entries


def test_the_extraction_holds_every_grammar_0755(grammars_dir: Path, bundle: Bundle) -> None:
    """ACT-113: every bundled library, a regular file, 0755 like its directories, and no more."""
    assert len(bundle.grammars) == len(semble_grammars.available_languages()) > 0
    assert [g.language for g in bundle.grammars] == semble_grammars.available_languages()
    platform_dir = grammars_dir / bundle.platform
    assert sorted(os.listdir(grammars_dir)) == [bundle.platform]
    assert sorted(os.listdir(platform_dir)) == sorted(g.file for g in bundle.grammars)
    for directory in (grammars_dir, platform_dir):
        assert stat.S_IMODE(os.lstat(directory).st_mode) == 0o755
    for grammar in bundle.grammars:
        status = os.lstat(platform_dir / grammar.file)
        assert stat.S_ISREG(status.st_mode)
        assert stat.S_IMODE(status.st_mode) == 0o755
    assert grammars.verify_dir(grammars_dir) == bundle


def test_extracting_over_an_intact_directory_writes_nothing(
    grammars_dir: Path, bundle: Bundle, tmp_path: Path
) -> None:
    """ACT-113: run again over an intact directory, extraction only verifies it."""
    directory = copy_of(grammars_dir, tmp_path)
    before = listing(directory)
    assert grammars.extract(directory) == bundle
    assert listing(directory) == before


Damage = Callable[[Path, Bundle], None]


def tamper(directory: Path, bundle: Bundle) -> None:
    """One byte more in the Python library."""
    with library(directory, bundle).open("ab") as handle:
        handle.write(b"\0")


def remove(directory: Path, bundle: Bundle) -> None:
    """No Python library."""
    library(directory, bundle).unlink()


def symlink(directory: Path, bundle: Bundle) -> None:
    """The Python library replaced by a link to an intact copy of it."""
    target = directory.parent / "elsewhere.so"
    shutil.copyfile(library(directory, bundle), target)
    library(directory, bundle).unlink()
    library(directory, bundle).symlink_to(target)


def fifo(directory: Path, bundle: Bundle) -> None:
    """A FIFO in the Python library's place."""
    library(directory, bundle).unlink()
    os.mkfifo(library(directory, bundle))


DAMAGES: list[tuple[Damage, str]] = [
    (tamper, "grammar python (libtree_sitter_python.so) does not match the pinned SHA-256"),
    (remove, "grammar python (libtree_sitter_python.so) cannot be opened"),
    (symlink, "grammar python (libtree_sitter_python.so) is a symbolic link"),
    (fifo, "grammar python (libtree_sitter_python.so) is not a regular file"),
]


@pytest.mark.parametrize(("damage", "problem"), DAMAGES)
def test_a_damaged_library_is_refused_and_repaired(
    grammars_dir: Path,
    bundle: Bundle,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    damage: Damage,
    problem: str,
) -> None:
    """ACT-113: a tampered, missing, linked or special library fails; extraction replaces it."""
    directory = copy_of(grammars_dir, tmp_path)
    damage(directory, bundle)
    with pytest.raises(GrammarsError) as caught:
        grammars.verify_dir(directory)
    assert str(caught.value) == problem
    before = listing(directory)
    assert grammars.main(["--dest", str(directory), "--verify-only"]) == 1
    assert capsys.readouterr().err == f"grammars: {problem}\n"
    assert listing(directory) == before
    assert grammars.main(["--dest", str(directory)]) == 0
    assert capsys.readouterr().out == (
        f"semble-grammars 0.1.2: {len(bundle.grammars)} {bundle.platform} grammars verified\n"
    )
    assert stat.S_ISREG(os.lstat(library(directory, bundle)).st_mode)
    expected = sorted(os.listdir(grammars_dir / bundle.platform))
    assert sorted(os.listdir(directory / bundle.platform)) == expected


def test_a_platform_directory_missing_or_not_a_directory_is_refused(
    bundle: Bundle, tmp_path: Path
) -> None:
    """ACT-113: the directory must hold the platform's own directory, never a link to one."""
    with pytest.raises(GrammarsError, match="cannot be read: No such file or directory"):
        grammars.verify_dir(tmp_path)
    (tmp_path / "real").mkdir()
    (tmp_path / bundle.platform).symlink_to(tmp_path / "real")
    with pytest.raises(GrammarsError, match=f"{bundle.platform} is not a directory"):
        grammars.verify_dir(tmp_path)


def test_a_language_that_does_not_load_is_refused(
    grammars_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-113: a library that matches its digest but does not load as a grammar is refused."""
    real = loader._platform_manifest()
    python = real["languages"]["python"] | {"symbol": "tree_sitter_not_python"}
    broken = real | {"languages": real["languages"] | {"python": python}}
    monkeypatch.setattr(loader, "_platform_manifest", lambda: broken)
    with pytest.raises(GrammarsError, match="grammar python does not load: GrammarLoadError"):
        grammars.verify_dir(grammars_dir)


def test_an_archive_member_that_does_not_match_is_not_extracted(
    bundle: Bundle, tmp_path: Path
) -> None:
    """ACT-113: a library whose bytes miss the pinned digest is never put in place."""
    (python,) = [g for g in bundle.grammars if g.language == "python"]
    wrong = dataclasses.replace(bundle, grammars=(dataclasses.replace(python, sha256="0" * 64),))
    dest = tmp_path / "grammars"
    with pytest.raises(GrammarsError, match="grammar python cannot be extracted: ValueError"):
        grammars.extract(dest, wrong)
    assert os.listdir(dest / bundle.platform) == []


def test_another_version_or_platform_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """ACT-113: another semble-grammars, or a platform it bundles nothing for, is refused."""
    with pytest.raises(GrammarsError, match=r"semble-grammars 0\.1\.2 is required, found 0\.1\.1"):
        grammars.load_bundle("0.1.1")

    def unsupported() -> dict[str, Any]:
        raise semble_grammars.UnsupportedPlatformError

    monkeypatch.setattr(loader, "_platform_manifest", unsupported)
    with pytest.raises(GrammarsError, match="bundles no grammars for this platform"):
        grammars.load_bundle()


def test_use_points_semble_grammars_at_the_absolute_directory(
    grammars_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-113: in use, the directory is `SEMBLE_GRAMMARS_CACHE_DIR`, made absolute."""
    monkeypatch.delenv(grammars.ENV)
    grammars.verify_dir(grammars_dir)
    assert grammars.ENV not in os.environ  # verification leaves the environment as it was
    monkeypatch.chdir(grammars_dir.parent)
    grammars.use(Path(grammars_dir.name))
    assert os.environ[grammars.ENV] == str(grammars_dir)
    assert cache_dir() == grammars_dir


def test_the_module_runs_as_a_script(grammars_dir: Path, tmp_path: Path) -> None:
    """ACT-113: `python3 -m vaultgate_code.grammars` exits with main()'s status."""
    directory = copy_of(grammars_dir, tmp_path)
    command = [sys.executable, "-m", "vaultgate_code.grammars", "--dest", str(directory)]
    environment = {**os.environ, "PYTHONPATH": str(SRC)}
    verified = subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [*command, "--verify-only"], env=environment, capture_output=True, text=True, check=False
    )
    assert (verified.returncode, verified.stderr) == (0, "")
    assert verified.stdout.startswith("semble-grammars 0.1.2: ")
    remove(directory, grammars.load_bundle())
    refused = subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [*command, "--verify-only"], env=environment, capture_output=True, text=True, check=False
    )
    assert refused.returncode == 1
    assert refused.stderr == f"grammars: grammar python ({PYTHON}) cannot be opened\n"
