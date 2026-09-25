"""The command line and its environment fallbacks (ACT-113, ACT-114)."""

from __future__ import annotations

from pathlib import Path

import pytest

from vaultgate_code import __main__ as entry
from vaultgate_code.config import GIB, Config, ConfigError, parse

BASE = ["serve", "--state", "/srv/state", "--model", "/opt/model"]


def test_flags_set_every_setting() -> None:
    """ACT-114: the transport, the directories and every cap are flags."""
    config = parse(
        [
            *BASE,
            "--socket",
            "/run/code/code.sock",
            "--max-snapshots",
            "3",
            "--max-storage-bytes",
            "1000",
            "--max-memory-bytes",
            "2000",
            "--build-concurrency",
            "2",
        ],
        {},
    )
    assert config == Config(
        state=Path("/srv/state"),
        model=Path("/opt/model"),
        socket=Path("/run/code/code.sock"),
        max_snapshots=3,
        max_storage_bytes=1000,
        max_memory_bytes=2000,
        build_concurrency=2,
    )


def test_the_defaults() -> None:
    """ACT-107, ACT-114: 64 snapshots, 8 GiB on disk, 1 GiB in memory, one build at a time."""
    config = parse([*BASE, "--listen", "127.0.0.1:8000"], {})
    assert config.listen == ("127.0.0.1", 8000)
    assert config.socket is None
    assert (config.max_snapshots, config.max_storage_bytes) == (64, 8 * GIB)
    assert (config.max_memory_bytes, config.build_concurrency) == (GIB, 1)


def test_the_environment_is_the_fallback() -> None:
    """ACT-114: each flag may be set as VAULTGATE_CODE_<FLAG>; a flag wins."""
    environ = {
        "VAULTGATE_CODE_STATE": "/env/state",
        "VAULTGATE_CODE_MODEL": "/env/model",
        "VAULTGATE_CODE_LISTEN": "[::1]:9000",
        "VAULTGATE_CODE_MAX_SNAPSHOTS": "7",
        "VAULTGATE_CODE_BUILD_CONCURRENCY": "4",
    }
    config = parse(["serve", "--max-snapshots", "9"], environ)
    assert (config.state, config.model) == (Path("/env/state"), Path("/env/model"))
    assert config.listen == ("::1", 9000)
    assert (config.max_snapshots, config.build_concurrency) == (9, 4)


def test_the_transport_comes_from_one_source() -> None:
    """ACT-114: a transport flag replaces the environment's, never combines with it."""
    environ = {"VAULTGATE_CODE_LISTEN": "127.0.0.1:8000"}
    config = parse([*BASE, "--socket", "/run/code.sock"], environ)
    assert (config.socket, config.listen) == (Path("/run/code.sock"), None)
    socket_only = parse(BASE, {"VAULTGATE_CODE_SOCKET": "/run/env.sock"})
    assert socket_only.socket == Path("/run/env.sock")


@pytest.mark.parametrize(
    ("argv", "environ", "problem"),
    [
        (["serve", "--model", "/m", "--socket", "/s"], {}, "state and model are required"),
        (["serve", "--state", "/s", "--socket", "/s"], {}, "state and model are required"),
        (BASE, {}, "exactly one of socket and listen"),
        ([*BASE, "--socket", "/s", "--listen", "h:1"], {}, "exactly one of socket and listen"),
        (BASE, {"VAULTGATE_CODE_SOCKET": "/s", "VAULTGATE_CODE_LISTEN": "h:1"}, "exactly one"),
        ([*BASE, "--listen", "8000"], {}, "listen must be HOST:PORT"),
        ([*BASE, "--listen", ":8000"], {}, "listen must be HOST:PORT"),
        ([*BASE, "--listen", "host:"], {}, "listen must be HOST:PORT"),
        ([*BASE, "--listen", "host:65536"], {}, "listen must be HOST:PORT"),
        ([*BASE, "--listen", "host:\uff18\uff10"], {}, "listen must be HOST:PORT"),  # fullwidth 80
        ([*BASE, "--socket", "/s", "--max-snapshots", "0"], {}, "max_snapshots must be"),
        ([*BASE, "--socket", "/s", "--build-concurrency", "65"], {}, "build_concurrency must"),
        ([*BASE, "--socket", "/s", "--max-memory-bytes", "1e9"], {}, "max_memory_bytes must"),
        ([*BASE, "--socket", "/s"], {"VAULTGATE_CODE_MAX_STORAGE_BYTES": "-1"}, "max_storage"),
    ],
)
def test_unusable_settings_are_refused(
    argv: list[str], environ: dict[str, str], problem: str
) -> None:
    """ACT-114: a missing, conflicting or malformed setting names itself and nothing else."""
    with pytest.raises(ConfigError, match=problem):
        parse(argv, environ)


def test_the_command_line_exits_2_on_a_bad_setting(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACT-114: `python3 -m vaultgate_code serve` with an unusable setting exits 2 at once."""
    monkeypatch.delenv("VAULTGATE_CODE_SOCKET", raising=False)
    monkeypatch.delenv("VAULTGATE_CODE_LISTEN", raising=False)
    assert entry.main(BASE) == 2
    assert capsys.readouterr().err == (
        "vaultgate-code: exactly one of socket and listen is required\n"
    )
