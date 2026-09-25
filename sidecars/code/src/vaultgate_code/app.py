"""The running server: transports, start-up checks, signals and shutdown."""

from __future__ import annotations

import contextlib
import os
import signal
import socket
import socketserver
import stat
import threading
from collections.abc import Callable
from pathlib import Path
from types import FrameType

from vaultgate_code import engine, fetch_model, guard, logs
from vaultgate_code.config import Config, ConfigError
from vaultgate_code.server import Handler
from vaultgate_code.service import Service, now_ms


class TcpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """TCP, IPv4. No name lookup at bind, unlike http.server.HTTPServer."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


class Tcp6Server(TcpServer):
    """TCP, IPv6."""

    address_family = socket.AF_INET6


def clear_stale_socket(path: Path) -> None:
    """Remove a socket file nobody listens on; refuse anything else at that path."""
    try:
        status = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(status.st_mode):
        raise ConfigError("the socket path exists and is not a socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        try:
            probe.connect(str(path))
        except ConnectionRefusedError:
            path.unlink()
            return
    raise ConfigError("another server is listening on the socket")


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """A Unix domain socket created `0660`, removed at shutdown if it is still ours."""

    daemon_threads = True
    request_queue_size = 64
    identity: tuple[int, int] = (0, 0)

    def server_bind(self) -> None:
        """Replace a stale socket, then bind with a umask that yields 0660 at once."""
        path = Path(self.server_address)  # type: ignore[arg-type]
        clear_stale_socket(path)
        previous = os.umask(0o117)
        try:
            super().server_bind()
        finally:
            os.umask(previous)
        os.chmod(path, 0o660)
        status = os.lstat(path)
        self.identity = (status.st_dev, status.st_ino)

    def remove_socket(self) -> None:
        """Unlink the socket file, unless something else has replaced it."""
        path = Path(self.server_address)  # type: ignore[arg-type]
        with contextlib.suppress(FileNotFoundError):
            status = os.lstat(path)
            if (status.st_dev, status.st_ino) == self.identity:
                path.unlink()


class App:
    """The service behind its transport."""

    def __init__(
        self,
        config: Config,
        manifest: fetch_model.Manifest,
        clock: Callable[[], int] = now_ms,
        trim: Callable[[], None] | None = None,
    ) -> None:
        """Reconcile the state directory and bind the transport; the model must be loaded."""
        self.service = Service(config, manifest, clock, trim)
        self.service.store.reconcile()
        handler = type("BoundHandler", (Handler,), {"service": self.service})
        self.server: socketserver.BaseServer
        if config.socket is not None:
            self.server = UnixServer(str(config.socket), handler)
            self.transport = "unix"
        else:
            host, port = config.listen or ("", 0)
            server_class = Tcp6Server if ":" in host else TcpServer
            self.server = server_class((host, port), handler)
            self.transport = "tcp"

    def serve_forever(self) -> None:
        """Serve until `shutdown`."""
        self.server.serve_forever(poll_interval=0.2)

    def shutdown(self) -> None:
        """Stop `serve_forever` (from another thread)."""
        self.server.shutdown()

    def close(self) -> None:
        """Kill running builds, close the listener and remove the socket file."""
        self.service.runner.stop()
        self.server.server_close()
        if isinstance(self.server, UnixServer):
            self.server.remove_socket()


def start(config: Config) -> App:
    """Verify the model and `semble`, load the model and bind; raises on any mismatch."""
    manifest = fetch_model.verify_dir(config.model)
    engine.check_semble()
    engine.use_model(str(config.model))
    return App(config, manifest)


def run(config: Config) -> int:
    """The `serve` command: 0 after a clean shutdown on SIGTERM or SIGINT, 1 if it cannot start."""
    try:
        app = start(config)
    except (fetch_model.ModelError, ConfigError, RuntimeError, OSError) as error:
        logs.event("start_failed", reason=str(error))
        return 1
    guard.install()

    def stop(_signal: int, _frame: FrameType | None) -> None:
        threading.Thread(target=app.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    snapshots, _ = app.service.store.usage()
    logs.event("started", transport=app.transport, snapshots=snapshots)
    try:
        app.serve_forever()
    finally:
        app.close()
        logs.event("stopped")
    return 0
