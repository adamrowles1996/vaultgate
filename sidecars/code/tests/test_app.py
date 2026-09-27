"""The transports and start-up in this process (ACT-113, ACT-114); `test_serve` runs the command."""

from __future__ import annotations

import os
import socket
import stat
import threading
from pathlib import Path

import pytest

from client import Client
from conftest import config_for
from vaultgate_code import app, fetch_model, grammars
from vaultgate_code.config import ConfigError


def short_socket(tmp_path: Path) -> Path:
    """A socket path under the 108-byte limit of `sun_path` (pytest shortens `tmp_path`)."""
    return tmp_path / "s.sock"


def test_a_missing_socket_path_is_fine(tmp_path: Path) -> None:
    """ACT-114: nothing at the socket path is nothing to clear."""
    app.clear_stale_socket(tmp_path / "absent.sock")


def test_a_stale_socket_is_replaced(tmp_path: Path) -> None:
    """ACT-114: a socket file nobody listens on is removed before the bind."""
    path = short_socket(tmp_path)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
        stale.bind(str(path))
    assert stat.S_ISSOCK(os.lstat(path).st_mode)
    app.clear_stale_socket(path)
    assert not path.exists()


def test_a_live_socket_or_another_file_is_refused(tmp_path: Path) -> None:
    """ACT-114: the path of a listening socket, or of anything but a socket, is refused."""
    path = short_socket(tmp_path)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as live:
        live.bind(str(path))
        live.listen(1)
        with pytest.raises(ConfigError, match="another server is listening"):
            app.clear_stale_socket(path)
    path.unlink()
    path.write_text("not a socket")
    try:
        with pytest.raises(ConfigError, match="exists and is not a socket"):
            app.clear_stale_socket(path)
    finally:
        path.unlink()


def test_the_socket_is_0660_and_removed_only_if_still_ours(
    tmp_path: Path,
    model_dir: Path,
    manifest: fetch_model.Manifest,
    grammars_dir: Path,
    bundle: grammars.Bundle,
) -> None:
    """ACT-114: the socket is created 0660; shutdown leaves a file that replaced it alone."""
    path = short_socket(tmp_path)
    config = config_for(tmp_path / "state", model_dir, grammars_dir, socket=path)
    first = app.App(config, manifest, bundle)
    assert stat.S_IMODE(os.lstat(path).st_mode) == 0o660
    first.close()
    assert not path.exists()
    second = app.App(config, manifest, bundle)
    path.unlink()
    path.write_text("someone else's")
    second.close()
    assert path.read_text() == "someone else's"
    path.unlink()


def test_tcp_over_ipv6(
    tmp_path: Path,
    model_dir: Path,
    manifest: fetch_model.Manifest,
    grammars_dir: Path,
    bundle: grammars.Bundle,
) -> None:
    """ACT-114: an IPv6 listen address binds an IPv6 socket."""
    config = config_for(tmp_path / "state", model_dir, grammars_dir, listen=("::1", 0))
    served = app.App(config, manifest, bundle)
    assert isinstance(served.server, app.Tcp6Server)
    thread = threading.Thread(target=served.serve_forever, daemon=True)
    thread.start()
    host, port = served.server.server_address[:2]
    client = Client((str(host), int(port)))
    try:
        assert client.call("GET", "/v1/health")[0] == 200
    finally:
        client.close()
        served.shutdown()
        thread.join()
        served.close()


def test_start_verifies_the_model_and_the_grammars_first(
    tmp_path: Path, model_dir: Path, grammars_dir: Path
) -> None:
    """ACT-113: start-up verifies the model, semble and the grammars, then loads and binds."""
    good = config_for(tmp_path / "state", model_dir, grammars_dir)
    started = app.start(good)
    assert started.transport == "tcp"
    assert started.service.grammars.grammars
    started.close()
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(fetch_model.ModelError, match="other files"):
        app.start(config_for(tmp_path / "state", empty, grammars_dir))
    with pytest.raises(grammars.GrammarsError, match="cannot be read"):
        app.start(config_for(tmp_path / "state", model_dir, empty))
    assert os.environ[grammars.ENV] == str(grammars_dir)  # a refused directory is never in use
