"""The transports and start-up in this process (ACT-113, ACT-114); `test_serve` runs the command."""

from __future__ import annotations

import os
import socket
import stat
import threading
from pathlib import Path

import pytest

from client import Client
from vaultgate_code import app, fetch_model
from vaultgate_code.config import Config, ConfigError


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
    tmp_path: Path, model_dir: Path, manifest: fetch_model.Manifest
) -> None:
    """ACT-114: the socket is created 0660; shutdown leaves a file that replaced it alone."""
    path = short_socket(tmp_path)
    config = Config(state=tmp_path / "state", model=model_dir, socket=path)
    first = app.App(config, manifest)
    assert stat.S_IMODE(os.lstat(path).st_mode) == 0o660
    first.close()
    assert not path.exists()
    second = app.App(config, manifest)
    path.unlink()
    path.write_text("someone else's")
    second.close()
    assert path.read_text() == "someone else's"
    path.unlink()


def test_tcp_over_ipv6(tmp_path: Path, model_dir: Path, manifest: fetch_model.Manifest) -> None:
    """ACT-114: an IPv6 listen address binds an IPv6 socket."""
    config = Config(state=tmp_path / "state", model=model_dir, listen=("::1", 0))
    served = app.App(config, manifest)
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


def test_start_verifies_the_model_first(tmp_path: Path, model_dir: Path) -> None:
    """ACT-113: start-up verifies the model and semble, then loads the model and binds."""
    good = Config(state=tmp_path / "state", model=model_dir, listen=("127.0.0.1", 0))
    started = app.start(good)
    assert started.transport == "tcp"
    started.close()
    empty = tmp_path / "empty-model"
    empty.mkdir()
    with pytest.raises(fetch_model.ModelError, match="other files"):
        app.start(Config(state=tmp_path / "state", model=empty, listen=("127.0.0.1", 0)))
