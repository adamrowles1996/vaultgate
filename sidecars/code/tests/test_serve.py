"""`python3 -m vaultgate_code serve` run as systemd or a container runs it (ACT-113, ACT-114).

Each test starts the real command in a child interpreter with a fresh home, cache and temporary
directory, so it proves the runtime guard lets the build child start and that nothing is
written anywhere but the state directory: the model and grammars directories are only read.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import semble_grammars

import archives
import chunked
import repo
from client import Client

SIDECAR = Path(__file__).resolve().parents[1]
STARTUP_S = 120
QUERY = {
    "indexes": [{"key": "acme", "label": "acme"}],
    "content": ["code"],
    "query": "compute the invoice total with tax",
    "top_k": 3,
    "max_snippet_lines": 2,
}


class Sandbox:
    """A fresh home, cache and temporary directory, and the command's environment."""

    def __init__(self, tmp_path: Path) -> None:
        """Create the directories under `tmp_path`."""
        self.root = tmp_path
        self.home, self.tmp, self.state = tmp_path / "home", tmp_path / "tmp", tmp_path / "state"
        for directory in (self.home, self.tmp):
            directory.mkdir()
        inherited = {
            name: value
            for name, value in os.environ.items()
            if not name.startswith(("HF_", "SEMBLE_", "XDG_", "VAULTGATE_CODE_", "TOKENIZERS_"))
        }
        self.processes: list[subprocess.Popen[str]] = []
        self.environment = inherited | {
            "PYTHONPATH": str(SIDECAR / "src"),
            "HOME": str(self.home),
            "TMPDIR": str(self.tmp),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
        }

    def launch(self, *arguments: str, **environment: str) -> subprocess.Popen[str]:
        """Start `python3 -m vaultgate_code` with these arguments."""
        process = subprocess.Popen(  # noqa: S603 - this interpreter, fixed arguments
            [sys.executable, "-m", "vaultgate_code", *arguments],
            cwd=SIDECAR,
            env=self.environment | environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.processes.append(process)
        return process

    def close(self) -> None:
        """Kill whatever a failed test left running."""
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.communicate()

    def untouched(self) -> bool:
        """Nothing was written to the home, cache or temporary directory."""
        return not list(self.home.rglob("*")) and not list(self.tmp.rglob("*"))


@pytest.fixture
def sandbox(tmp_path: Path) -> Iterator[Sandbox]:
    """A sandbox whose commands are killed if the test fails before stopping them."""
    made = Sandbox(tmp_path)
    yield made
    made.close()


def connect(address: str | tuple[str, int], process: subprocess.Popen[str]) -> Client:
    """A client once the server answers health, failing if the command exits first."""
    deadline = time.monotonic() + STARTUP_S
    while time.monotonic() < deadline:
        assert process.poll() is None, process.communicate()[1]
        client = Client(address)
        try:
            if client.call("GET", "/v1/health")[0] == 200:
                return client
        except OSError:
            client.close()
            time.sleep(0.1)
    raise AssertionError("the sidecar did not start")


def stop(process: subprocess.Popen[str]) -> list[dict[str, Any]]:
    """SIGTERM, then the exit status must be 0; the log lines, parsed."""
    process.send_signal(signal.SIGTERM)
    _, errors = process.communicate(timeout=60)
    assert process.returncode == 0, errors
    return [json.loads(line) for line in errors.splitlines()]


def directories(state: Path, model: Path, grammars: Path) -> list[str]:
    """The three directory flags."""
    return ["--state", str(state), "--model", str(model), "--grammars", str(grammars)]


def listing(directory: Path) -> list[tuple[str, int, int, int]]:
    """Every entry below `directory`: its path, mode, size and modification time."""
    entries = []
    for path in sorted([directory, *directory.rglob("*")]):
        status = os.lstat(path)
        entries.append((str(path), status.st_mode, status.st_size, status.st_mtime_ns))
    return entries


def test_serve_on_a_socket_and_stop_on_sigterm(
    sandbox: Sandbox, model_dir: Path, grammars_dir: Path
) -> None:
    """ACT-113, ACT-114: a stale socket replaced, 0660, a real build and query, a clean stop."""
    path = sandbox.root / "run" / "code.sock"
    path.parent.mkdir()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
        stale.bind(str(path))
    arguments = [*directories(sandbox.state, model_dir, grammars_dir), "--socket", str(path)]
    process = sandbox.launch("serve", *arguments, "--max-snapshots", "4")
    client = connect(str(path), process)
    assert stat.S_IMODE(os.lstat(path).st_mode) == 0o660
    assert client.call("GET", "/v1/health")[1]["limits"]["max_snapshots"] == 4
    status, meta, _ = client.call(
        "PUT",
        "/v1/snapshots/acme",
        archives.archive(repo.members()),
        {"X-Vaultgate-Build": archives.header(max_file_bytes=repo.MAX_FILE_BYTES)},
    )
    assert (status, meta["variants"]["code"]["files"]) == (200, 4)
    status, found = client.post("/v1/search", QUERY)
    assert (status, found["results"][0]["file_path"]) == (200, "src/billing/invoice.py")
    read = {"key": "acme", "file_path": "README.md", "max_lines": 1}
    answer = {"start_line": 1, "end_line": 1, "total_lines": 3, "text": "# Acme widgets"}
    assert client.post("/v1/read", read) == (
        200,
        {"file_path": "README.md", **answer, "truncated": True},
    )
    client.close()
    lines = stop(process)
    assert not path.exists()
    assert [line["event"] for line in lines][:1] == ["started"]
    assert lines[-1]["event"] == "stopped"
    operations = [line.get("op") for line in lines if line["event"] == "request"]
    assert {"health", "build", "search", "read"} <= set(operations)
    everything = "\n".join(json.dumps(line) for line in lines)
    for secret in ("invoice", "README", "Acme", "tax"):
        assert secret not in everything
    assert sandbox.untouched()
    assert sorted(p.name for p in sandbox.state.iterdir()) == ["snapshots", "tmp"]


def free_port() -> int:
    """A TCP port nothing listens on now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
    return port


def test_serve_over_tcp_from_the_environment(
    sandbox: Sandbox, model_dir: Path, grammars_dir: Path
) -> None:
    """ACT-113, ACT-114: the container's settings may come from VAULTGATE_CODE_* alone."""
    port = free_port()
    process = sandbox.launch(
        "serve",
        VAULTGATE_CODE_STATE=str(sandbox.state),
        VAULTGATE_CODE_MODEL=str(model_dir),
        VAULTGATE_CODE_GRAMMARS=str(grammars_dir),
        VAULTGATE_CODE_LISTEN=f"127.0.0.1:{port}",
        VAULTGATE_CODE_MAX_MEMORY_BYTES="1048576",
    )
    client = connect(("127.0.0.1", port), process)
    health = client.call("GET", "/v1/health")[1]
    assert health["limits"]["max_memory_bytes"] == 1 << 20
    assert health["grammars"] == len(semble_grammars.available_languages())
    client.close()
    started = stop(process)[0]
    assert (started["event"], started["transport"]) == ("started", "tcp")
    assert started["grammars"] == health["grammars"]
    assert sandbox.untouched()


def test_the_grammars_directory_is_only_read(
    sandbox: Sandbox, model_dir: Path, grammars_dir: Path
) -> None:
    """ACT-113: a read-only grammars directory serves tree-sitter chunks and is never written."""
    grammars = Path(shutil.copytree(grammars_dir, sandbox.root / "grammars"))
    for path in [grammars, *grammars.rglob("*")]:
        path.chmod(0o555)
    before = listing(grammars)
    port = free_port()
    arguments = [*directories(sandbox.state, model_dir, grammars), "--listen", f"127.0.0.1:{port}"]
    process = sandbox.launch("serve", *arguments)
    try:
        client = connect(("127.0.0.1", port), process)
        members = [archives.file(name, data) for name, data in chunked.FILES.items()]
        spec = {"X-Vaultgate-Build": archives.header()}
        status, _, _ = client.call("PUT", "/v1/snapshots/plan", archives.archive(members), spec)
        assert status == 200
        search = QUERY | {"indexes": [{"key": "plan", "label": "plan"}], "top_k": 10}
        found = client.post("/v1/search", search | {"paths": ["src/deploy/plan.py"]})[1]
        spans = sorted((r["start_line"], r["end_line"]) for r in found["results"])
        assert spans == chunked.TREE_SITTER["src/deploy/plan.py"]
        client.close()
        stop(process)
        assert listing(grammars) == before
    finally:
        for path in [grammars, *grammars.rglob("*")]:
            path.chmod(0o755)
    assert sandbox.untouched()
    assert sorted(p.name for p in sandbox.state.iterdir()) == ["snapshots", "tmp"]


def refusal(process: subprocess.Popen[str]) -> dict[str, Any]:
    """The one log line of a command that must not start, which must exit 1."""
    _, errors = process.communicate(timeout=STARTUP_S)
    assert process.returncode == 1
    (line,) = [json.loads(line) for line in errors.splitlines()]
    assert line["event"] == "start_failed"
    refused: dict[str, Any] = line
    return refused


def test_a_model_that_does_not_verify_stops_start_up(sandbox: Sandbox, grammars_dir: Path) -> None:
    """ACT-113: a model directory that does not hold exactly the pinned files is refused."""
    empty = sandbox.root / "model"
    empty.mkdir()
    arguments = [*directories(sandbox.state, empty, grammars_dir), "--listen", "127.0.0.1:0"]
    assert refusal(sandbox.launch("serve", *arguments))["reason"] == (
        "the model directory holds other files than the pinned model's"
    )


def test_grammars_that_do_not_verify_stop_start_up(
    sandbox: Sandbox, model_dir: Path, grammars_dir: Path
) -> None:
    """ACT-113: without every grammar intact the command refuses to start, and says why."""
    listen = ["--listen", "127.0.0.1:0"]
    empty = sandbox.root / "grammars"
    empty.mkdir()
    process = sandbox.launch("serve", *directories(sandbox.state, model_dir, empty), *listen)
    assert refusal(process)["reason"] == (
        "the grammars directory cannot be read: No such file or directory"
    )
    damaged = Path(shutil.copytree(grammars_dir, sandbox.root / "damaged"))
    (python,) = damaged.glob("*/libtree_sitter_python.so")
    python.write_bytes(python.read_bytes()[:-1])
    process = sandbox.launch("serve", *directories(sandbox.state, model_dir, damaged), *listen)
    assert refusal(process)["reason"] == (
        "grammar python (libtree_sitter_python.so) does not match the pinned SHA-256"
    )
    unnamed = sandbox.launch("serve", "--state", str(sandbox.state), "--model", str(model_dir))
    _, errors = unnamed.communicate(timeout=STARTUP_S)
    assert unnamed.returncode == 2
    assert errors == "vaultgate-code: state, model and grammars are required\n"
    assert not sandbox.state.exists()


def test_a_path_that_is_not_a_socket_stops_start_up(
    sandbox: Sandbox, model_dir: Path, grammars_dir: Path
) -> None:
    """ACT-114: the socket path must be free or a stale socket; a file there is left alone."""
    occupied = sandbox.root / "code.sock"
    occupied.write_text("keep me")
    arguments = [*directories(sandbox.state, model_dir, grammars_dir), "--socket", str(occupied)]
    process = sandbox.launch("serve", *arguments)
    _, errors = process.communicate(timeout=STARTUP_S)
    assert process.returncode == 1
    assert json.loads(errors)["reason"] == "the socket path exists and is not a socket"
    assert occupied.read_text() == "keep me"
