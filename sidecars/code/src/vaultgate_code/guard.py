"""A runtime guard: no outbound network, no name lookups, no processes but the build child.

`sys.addaudithook` makes the interpreter call `audit` before each of these operations, and an
exception there stops the operation. The server installs it once it is listening, and the
build child before it touches `semble`. The build child itself is started by
`multiprocessing`'s spawn method, which raises none of the events refused here. A hook can
never be removed, so the tests exercise `audit` directly and `install` only in child processes.
"""

from __future__ import annotations

import socket
import sys

REFUSED = frozenset(
    {
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.posix_spawn",
        "os.spawn",
        "os.fork",
        "os.forkpty",
        "pty.spawn",
        "socket.getaddrinfo",
        "socket.gethostbyname",
        "socket.gethostbyaddr",
        "socket.getnameinfo",
        "urllib.Request",
        "http.client.connect",
        "webbrowser.open",
    }
)
# Refused unless the socket is a Unix domain socket.
OUTBOUND = frozenset({"socket.connect", "socket.sendto", "socket.sendmsg"})


def audit(event: str, arguments: tuple[object, ...]) -> None:
    """Refuse the events above; the message names the event and nothing else."""
    if event in REFUSED:
        raise PermissionError(f"vaultgate-code refuses {event}")
    if event in OUTBOUND:
        family = getattr(arguments[0], "family", None)
        if family != socket.AF_UNIX:
            raise PermissionError(f"vaultgate-code refuses {event}")


def install() -> None:
    """Install the guard for the rest of the process's life."""
    sys.addaudithook(audit)
