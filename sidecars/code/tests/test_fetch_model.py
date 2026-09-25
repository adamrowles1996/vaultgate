"""Fetching and verifying the pinned model (ACT-113): exact files, sizes and SHA-256 only."""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import IO

import pytest

from vaultgate_code import fetch_model
from vaultgate_code.fetch_model import Manifest, ModelError, ModelFile

FILES = {"config.json": b'{"normalize": true}', "model.safetensors": b"weights" * 100}


def manifest(files: dict[str, bytes] = FILES) -> Manifest:
    """A small manifest pinning `files`."""
    entries = tuple(
        ModelFile(name, len(data), hashlib.sha256(data).hexdigest()) for name, data in files.items()
    )
    return Manifest(
        "minishlab/test-model",
        "a" * 40,
        "https://example.invalid/{model}/{revision}/{path}",
        entries,
    )


class Served:
    """A fake opener serving each URL's bytes (or other bytes) and recording the URLs."""

    def __init__(
        self, files: dict[str, bytes] = FILES, override: dict[str, bytes] | None = None
    ) -> None:
        """Serve `files`, with `override` replacing some."""
        self.files = files | (override or {})
        self.urls: list[str] = []

    def __call__(self, url: str) -> IO[bytes]:
        """Open one URL."""
        self.urls.append(url)
        return io.BytesIO(self.files[url.rsplit("/", 1)[1]])


def test_the_shipped_manifest_pins_the_model() -> None:
    """ACT-113: model.json pins potion-code-16M-v2 at a commit, with each file's SHA-256."""
    pinned = fetch_model.load_manifest()
    assert pinned.model == "minishlab/potion-code-16M-v2"
    assert pinned.revision == "e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b"
    names = {entry.path: entry for entry in pinned.files}
    assert sorted(names) == ["config.json", "model.safetensors", "modules.json", "tokenizer.json"]
    assert names["model.safetensors"].size == 32_490_072
    assert (
        names["model.safetensors"].sha256
        == "75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c"
    )
    assert pinned.url_for(names["config.json"]) == (
        "https://huggingface.co/minishlab/potion-code-16M-v2/resolve/"
        "e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b/config.json"
    )


def test_fetch_downloads_verifies_and_skips_intact_files(tmp_path: Path) -> None:
    """ACT-113: each file is fetched at the pinned revision, verified, and kept once intact."""
    served = Served()
    dest = tmp_path / "model"
    assert fetch_model.fetch(dest, manifest(), served) == manifest()
    assert {p.name: p.read_bytes() for p in dest.iterdir()} == FILES
    assert all((dest / name).stat().st_mode & 0o777 == 0o644 for name in FILES)
    assert served.urls == [
        f"https://example.invalid/minishlab/test-model/{'a' * 40}/{name}" for name in FILES
    ]
    (dest / "config.json").write_bytes(b"tampered")
    again = Served()
    fetch_model.fetch(dest, manifest(), again)
    assert again.urls == [served.urls[0]]
    assert (dest / "config.json").read_bytes() == FILES["config.json"]


@pytest.mark.parametrize("served", [b"weights" * 101, b"weights" * 99, b"WEIGHTS" * 100])
def test_fetch_refuses_anything_but_the_pinned_bytes(tmp_path: Path, served: bytes) -> None:
    """ACT-113: a longer, shorter or different download is refused and leaves nothing behind."""
    dest = tmp_path / "model"
    with pytest.raises(ModelError):
        fetch_model.fetch(dest, manifest(), Served(override={"model.safetensors": served}))
    assert sorted(p.name for p in dest.iterdir()) == ["config.json"]


def test_verify_dir(tmp_path: Path) -> None:
    """ACT-113: exactly the pinned files, regular and matching; anything else is refused."""
    pinned = manifest()
    dest = tmp_path / "model"
    fetch_model.fetch(dest, pinned, Served())
    assert fetch_model.verify_dir(dest, pinned) == pinned
    (dest / "README.md").write_text("extra")
    with pytest.raises(ModelError, match="other files"):
        fetch_model.verify_dir(dest, pinned)
    (dest / "README.md").unlink()
    (dest / "config.json").unlink()
    (dest / "config.json").symlink_to(dest / "model.safetensors")
    with pytest.raises(ModelError, match="cannot be opened"):
        fetch_model.verify_dir(dest, pinned)
    (dest / "config.json").unlink()
    (dest / "config.json").mkdir()
    with pytest.raises(ModelError, match="config.json is not a regular file"):
        fetch_model.verify_dir(dest, pinned)
    with pytest.raises(ModelError, match="cannot be read"):
        fetch_model.verify_dir(tmp_path / "absent", pinned)


def test_a_fifo_in_place_of_a_model_file_is_refused(tmp_path: Path) -> None:
    """ACT-113: a model file must be a regular file, and a FIFO does not block the check."""
    pinned = manifest({"pipe": b"x"})
    os.mkfifo(tmp_path / "pipe")
    with pytest.raises(ModelError, match="not a regular file"):
        fetch_model.verify_file(tmp_path / "pipe", pinned.files[0])


def test_https_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """ACT-113: the model is fetched over HTTPS only, redirects included."""
    with pytest.raises(ModelError, match="HTTPS only"):
        fetch_model.https_open("http://huggingface.co/x")
    opened: list[tuple[str, float]] = []

    class Opener:
        def open(self, request: urllib.request.Request, timeout: float) -> IO[bytes]:
            opened.append((request.full_url, timeout))
            return io.BytesIO(b"ok")

    monkeypatch.setattr(urllib.request, "build_opener", lambda *_handlers: Opener())
    assert fetch_model.https_open("https://huggingface.co/x").read() == b"ok"
    assert opened == [("https://huggingface.co/x", fetch_model.TIMEOUT_S)]
    handler = fetch_model._HttpsOnlyRedirects()
    request = urllib.request.Request("https://huggingface.co/x")
    with pytest.raises(ModelError, match="away from HTTPS"):
        handler.redirect_request(request, io.BytesIO(), 302, "Found", {}, "http://cdn.example/x")
    followed = handler.redirect_request(
        request, io.BytesIO(), 302, "Found", {}, "https://cdn.example/x"
    )
    assert followed is not None
    assert followed.full_url == "https://cdn.example/x"


def test_the_command_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """ACT-113: `python3 -m vaultgate_code.fetch_model --dest DIR [--verify-only]`."""
    real = fetch_model.load_manifest()
    small = manifest()
    monkeypatch.setattr(fetch_model, "load_manifest", lambda: small)
    served = Served()
    monkeypatch.setattr(fetch_model, "https_open", served)
    monkeypatch.setattr(fetch_model.fetch, "__defaults__", (None, served))
    dest = tmp_path / "model"
    assert fetch_model.main(["--dest", str(dest), "--verify-only"]) == 1
    assert "cannot be read" in capsys.readouterr().err
    assert fetch_model.main(["--dest", str(dest)]) == 0
    assert f"minishlab/test-model@{'a' * 40} verified in {dest}" in capsys.readouterr().out
    assert fetch_model.main(["--dest", str(dest), "--verify-only"]) == 0
    assert real.model == "minishlab/potion-code-16M-v2"


def test_the_module_runs_as_a_script(tmp_path: Path, model_dir: Path) -> None:
    """ACT-113: `python3 -m vaultgate_code.fetch_model` exits with main()'s status."""
    dest = tmp_path / "model"
    shutil.copytree(model_dir, dest)
    command = [sys.executable, "-m", "vaultgate_code.fetch_model", "--dest", str(dest)]
    environment = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
    verified = subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [*command, "--verify-only"], env=environment, capture_output=True, text=True, check=False
    )
    assert (verified.returncode, verified.stderr) == (0, "")
    assert "potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b" in verified.stdout
    (dest / "config.json").write_bytes(b"{}")
    refused = subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [*command, "--verify-only"], env=environment, capture_output=True, text=True, check=False
    )
    assert refused.returncode == 1
    assert refused.stderr == "fetch_model: config.json does not match the pinned SHA-256\n"
