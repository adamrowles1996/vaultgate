"""Shared fixtures: the real model and grammars, services and servers over temporary state."""

from __future__ import annotations

import io
import os
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

import archives
import repo
from client import Client
from vaultgate_code import engine, fetch_model, grammars
from vaultgate_code.app import App
from vaultgate_code.config import Config
from vaultgate_code.service import Service

SIDECAR = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(os.environ.get("VAULTGATE_CODE_TEST_MODEL", SIDECAR / ".model")).resolve()
# A grammars directory extracted beforehand (`python3 -m vaultgate_code.grammars`) saves the
# session's extraction; by default each session extracts afresh into a temporary directory.
PREPARED_GRAMMARS = os.environ.get("VAULTGATE_CODE_TEST_GRAMMARS")


class Clock:
    """Milliseconds that move forward by one on every reading."""

    def __init__(self, start: int = 1_790_000_000_000) -> None:
        """Start at `start`."""
        self.now = start

    def __call__(self) -> int:
        """Advance and read."""
        self.now += 1
        return self.now


@pytest.fixture(scope="session")
def model_dir() -> Path:
    """The pinned model, verified (fetch it with `python3 -m vaultgate_code.fetch_model`)."""
    try:
        fetch_model.verify_dir(MODEL_DIR)
    except fetch_model.ModelError as error:
        pytest.fail(f"the pinned model is required at {MODEL_DIR}: {error}")
    engine.use_model(str(MODEL_DIR))
    return MODEL_DIR


@pytest.fixture(scope="session")
def manifest(model_dir: Path) -> fetch_model.Manifest:
    """The pinned model's manifest."""
    return fetch_model.verify_dir(model_dir)


@pytest.fixture(scope="session")
def grammars_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Every bundled grammar, extracted once per session and verified."""
    if PREPARED_GRAMMARS is not None:
        return Path(PREPARED_GRAMMARS).resolve()
    directory = tmp_path_factory.mktemp("grammars") / "grammars"
    grammars.extract(directory)
    return directory


@pytest.fixture(scope="session", autouse=True)
def bundle(grammars_dir: Path) -> grammars.Bundle:
    """The grammars in use for the whole session, as `serve` puts them in use.

    Every build child a test starts inherits `SEMBLE_GRAMMARS_CACHE_DIR`.
    """
    return grammars.use(grammars_dir)


ServiceFactory = Callable[..., Service]


def config_for(state: Path, model: Path, grammars_dir: Path, **options: Any) -> Config:
    """A configuration over TCP on an ephemeral port unless `options` name a transport."""
    if "socket" not in options:
        options.setdefault("listen", ("127.0.0.1", 0))
    return Config(state=state, model=model, grammars=grammars_dir, **options)


@pytest.fixture
def make_service(
    tmp_path: Path,
    model_dir: Path,
    manifest: fetch_model.Manifest,
    grammars_dir: Path,
    bundle: grammars.Bundle,
) -> Iterator[ServiceFactory]:
    """Services over a fresh state directory (or the one given), reconciled."""
    made: list[Service] = []

    def factory(**options: Any) -> Service:
        clock = options.pop("clock", Clock())
        trim = options.pop("trim", lambda: None)
        state = options.pop("state", tmp_path / "state")
        config = config_for(state, model_dir, grammars_dir, **options)
        service = Service(config, manifest, bundle, clock, trim)
        service.store.reconcile()
        made.append(service)
        return service

    yield factory
    for service in made:
        service.runner.stop()


def put(
    service: Service, key: str, members: list[archives.Member] | None = None, **spec: Any
) -> Any:
    """Build a snapshot of the fixture repository (or `members`) through the service."""
    body = archives.archive(repo.members() if members is None else members)
    return service.put(key, archives.header(**spec), io.BytesIO(body))


@pytest.fixture(scope="session")
def shared(
    tmp_path_factory: pytest.TempPathFactory,
    model_dir: Path,
    manifest: fetch_model.Manifest,
    grammars_dir: Path,
    bundle: grammars.Bundle,
) -> Iterator[Service]:
    """One service with the fixture repository as `acme` (every variant) and `acme-code` (code).

    For tests that only read.
    """
    state = tmp_path_factory.mktemp("shared") / "state"
    config = config_for(state, model_dir, grammars_dir)
    service = Service(config, manifest, bundle, Clock(), lambda: None)
    service.store.reconcile()
    variants = [["code"], ["docs"], ["config"], ["code", "docs", "config"]]
    put(service, "acme", variants=variants, max_file_bytes=repo.MAX_FILE_BYTES)
    put(service, "acme-code", max_file_bytes=repo.MAX_FILE_BYTES)
    yield service
    service.runner.stop()


@pytest.fixture
def serve(
    tmp_path: Path,
    model_dir: Path,
    manifest: fetch_model.Manifest,
    grammars_dir: Path,
    bundle: grammars.Bundle,
) -> Iterator[Callable[..., Client]]:
    """Start an App in a thread over TCP (default) or a Unix socket; returns a client."""
    running: list[tuple[App, threading.Thread, Client]] = []

    def start(transport: str = "tcp", **options: Any) -> Client:
        state = options.pop("state", tmp_path / "state")
        where: dict[str, Any] = (
            {"socket": tmp_path / "code.sock"}
            if transport == "unix"
            else {"listen": ("127.0.0.1", 0)}
        )
        config = config_for(state, model_dir, grammars_dir, **where, **options)
        app = App(config, manifest, bundle, Clock())
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        address = app.server.server_address
        client = Client(address if transport == "unix" else tuple(address))  # type: ignore[arg-type]
        client.app = app  # type: ignore[attr-defined]
        running.append((app, thread, client))
        return client

    yield start
    for app, thread, client in running:
        client.close()
        app.shutdown()
        thread.join()
        app.close()
