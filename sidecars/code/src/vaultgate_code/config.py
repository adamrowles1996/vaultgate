"""Command line and environment: each `--flag` may also be set as `VAULTGATE_CODE_<FLAG>`."""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

GIB = 1 << 30
PREFIX = "VAULTGATE_CODE_"
MAX_PORT = 65535


class ConfigError(Exception):
    """The configuration is unusable; the message says which setting."""


@dataclass(frozen=True)
class Config:
    """The server's settings."""

    state: Path
    model: Path
    socket: Path | None = None
    listen: tuple[str, int] | None = None
    max_snapshots: int = 64
    max_storage_bytes: int = 8 * GIB
    max_memory_bytes: int = GIB
    build_concurrency: int = 1


# (flag, bounds) for the integer settings; the defaults are Config's.
INTEGERS = {
    "max_snapshots": (1, 100_000),
    "max_storage_bytes": (1, 1 << 50),
    "max_memory_bytes": (1, 1 << 50),
    "build_concurrency": (1, 64),
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m vaultgate_code")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="serve the sidecar protocol")
    serve.add_argument("--state", help="the state directory (snapshots and indexes)")
    serve.add_argument("--model", help="the verified model directory (fetch_model)")
    serve.add_argument("--socket", help="serve on this Unix domain socket (mode 0660)")
    serve.add_argument("--listen", help="serve on HOST:PORT over TCP (an internal network only)")
    for name in INTEGERS:
        serve.add_argument(f"--{name.replace('_', '-')}")
    return parser


def _listen(value: str) -> tuple[str, int]:
    host, _, port = value.rpartition(":")
    host = host.removeprefix("[").removesuffix("]")
    if not host or not (port.isascii() and port.isdigit()) or int(port) > MAX_PORT:
        raise ConfigError("listen must be HOST:PORT")
    return host, int(port)


def _integer(name: str, value: str) -> int:
    low, high = INTEGERS[name]
    if not (value.isascii() and value.isdigit()) or not low <= int(value) <= high:
        raise ConfigError(f"{name} must be an integer from {low} to {high}")
    return int(value)


def parse(argv: Sequence[str] | None, environ: Mapping[str, str]) -> Config:
    """Read the flags, falling back to the environment; flags win.

    The transport is taken whole from one source: if either --socket or --listen is given,
    the environment's are ignored. Exactly one of the two must be set.
    """
    args = vars(_parser().parse_args(argv))

    def setting(name: str) -> str | None:
        value = args[name]
        return value if value is not None else environ.get(PREFIX + name.upper())

    state, model = setting("state"), setting("model")
    if state is None or model is None:
        raise ConfigError("state and model are required")
    if args["socket"] is not None or args["listen"] is not None:
        socket, listen = args["socket"], args["listen"]
    else:
        socket, listen = environ.get(PREFIX + "SOCKET"), environ.get(PREFIX + "LISTEN")
    if (socket is None) == (listen is None):
        raise ConfigError("exactly one of socket and listen is required")
    integers = {
        name: _integer(name, value) for name in INTEGERS if (value := setting(name)) is not None
    }
    return Config(
        state=Path(state),
        model=Path(model),
        socket=None if socket is None else Path(socket),
        listen=None if listen is None else _listen(listen),
        **integers,
    )
