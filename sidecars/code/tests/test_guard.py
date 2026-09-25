"""The runtime guard: no outbound network, no name lookups, no processes but the build child.

An audit hook can never be removed, so `install` runs only in a child interpreter here, which
then tries each refused operation and starts a `multiprocessing` spawn child the way the
build runner does (ACT-113, ACT-114).
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from vaultgate_code import guard

SIDECAR = Path(__file__).resolve().parents[1]

ATTEMPTS = r"""
import json, multiprocessing, os, socket, subprocess, urllib.request
from vaultgate_code import guard

guard.install()
outcomes = {}

def attempt(name, action):
    try:
        action()
    except PermissionError as error:
        outcomes[name] = str(error)
    except OSError as error:
        outcomes[name] = type(error).__name__

def udp():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.sendto(b"x", ("127.0.0.1", 9))

def tcp():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.connect(("127.0.0.1", 9))

def unix():
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect("/nonexistent/vaultgate-code.sock")

attempt("getaddrinfo", lambda: socket.getaddrinfo("localhost", 80))
attempt("gethostbyname", lambda: socket.gethostbyname("localhost"))
attempt("tcp", tcp)
attempt("udp", udp)
attempt("unix", unix)
attempt("subprocess", lambda: subprocess.run(["true"], check=False))
attempt("system", lambda: os.system("true"))
attempt("fork", os.fork)
attempt("exec", lambda: os.execv("/bin/true", ["true"]))
attempt("posix_spawn", lambda: os.posix_spawn("/bin/true", ["true"], {}))
attempt("urllib", lambda: urllib.request.urlopen("https://example.invalid/"))
child = multiprocessing.get_context("spawn").Process(target=os.getpid)
child.start()
child.join(60)
outcomes["spawn"] = child.exitcode
print(json.dumps(outcomes))
"""


def test_the_guard_refuses_network_and_processes_but_not_the_build_child() -> None:
    """ACT-113, ACT-114: lookups, IP sockets and processes refused; AF_UNIX and spawn allowed."""
    environment = {**os.environ, "PYTHONPATH": str(SIDECAR / "src")}
    finished = subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [sys.executable, "-c", ATTEMPTS],
        env=environment,
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    outcomes = json.loads(finished.stdout)
    refusals = {
        "getaddrinfo": "socket.getaddrinfo",
        "gethostbyname": "socket.gethostbyname",
        "tcp": "socket.connect",
        "udp": "socket.sendto",
        "subprocess": "subprocess.Popen",
        "system": "os.system",
        "fork": "os.fork",
        "exec": "os.exec",
        "posix_spawn": "os.posix_spawn",
        "urllib": "urllib.Request",
    }
    for attempt, event in refusals.items():
        assert outcomes[attempt] == f"vaultgate-code refuses {event}"
    assert outcomes["unix"] == "FileNotFoundError"  # allowed through, and simply absent
    assert outcomes["spawn"] == 0


@pytest.mark.parametrize("event", sorted(guard.REFUSED))
def test_every_refused_event_raises(event: str) -> None:
    """ACT-113: each refused event raises PermissionError naming only the event."""
    with pytest.raises(PermissionError, match=f"^vaultgate-code refuses {event}$"):
        guard.audit(event, ())


@pytest.mark.parametrize("event", sorted(guard.OUTBOUND))
def test_outbound_sockets_other_than_unix_are_refused(event: str) -> None:
    """ACT-114: connect, sendto and sendmsg pass for AF_UNIX sockets only."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as unix:
        guard.audit(event, (unix, "/run/x.sock"))
    for family in (socket.AF_INET, socket.AF_INET6):
        with socket.socket(family, socket.SOCK_STREAM) as other, pytest.raises(PermissionError):
            guard.audit(event, (other, ("::1", 1)))
    with pytest.raises(PermissionError):
        guard.audit(event, (object(), None))


def test_other_events_pass() -> None:
    """ACT-113: imports, file opens and the rest of the interpreter's events are not refused."""
    for event in ("open", "import", "exec", "socket.bind", "os.listdir", "ctypes.dlopen"):
        guard.audit(event, ())
