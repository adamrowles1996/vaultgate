# vaultgate code sidecar

The search engine behind vaultgate's `code` connector ([spec 14.8](../../docs/spec/14a-code-connector.md),
[ADR 0008](../../docs/adr/0008-code-search-connector.md)). vaultgate downloads a repository's
archive from GitHub with a token the sidecar never sees and streams it here; the sidecar extracts
it into a **snapshot**, builds [`semble`](https://github.com/MinishLab/semble) indexes over it
(one per content selection, as `semble`'s own MCP server keeps them) and answers
`code_search`, `code_find_related` and `code_read`. It speaks the JSON protocol in
[PROTOCOL.md](PROTOCOL.md) and nothing else.

It is Python 3.12 with one runtime dependency, `semble` 0.6.1, used as a library
(`SembleIndex.from_path`, `merge`, `search`, `find_related`, `save`, `load_from_disk` and
`semble.utils`), never through `semble`'s MCP server or `SembleIndex.from_git`. The embedding
model is `minishlab/potion-code-16M-v2` at the revision pinned in
[`model.json`](src/vaultgate_code/model.json).

## Security model

- **No credential, no network.** The sidecar never receives a token and never opens an outbound
  connection. It runs with `HF_HUB_OFFLINE=1`, loads the model only from a local directory whose
  every file it checks against the pinned SHA-256 at start-up (and refuses to start on a
  mismatch), and installs a Python audit hook once it is listening that refuses name lookups,
  sockets other than `AF_UNIX`, `subprocess`, `os.system`, `fork`, `exec` and `posix_spawn`. The
  one process it starts is the build child, through `multiprocessing`'s `spawn` method. Placement
  is the other half: a Unix socket only vaultgate's group may open, or an internal network.
- **Hostile archives.** Extraction is streamed and capped: compressed bytes, decompressed bytes
  (the decompression-bomb guard), members, files and bytes written. Exactly one top-level
  directory is stripped. An absolute name, a `..` segment, a backslash, a NUL or a name over
  1 024 bytes fails the build. Links, devices and FIFOs are skipped and counted, never created.
  `include` and `exclude` (gitignore syntax) decide before a file is written, so an excluded file
  never exists on disk. Files are created exclusively through directory descriptors opened with
  `O_NOFOLLOW`, `0644` whatever the archive says, with `tarfile`'s data filter applied as well.
- **Reads stay inside the snapshot.** Every path argument is a canonical repository-relative path;
  a read is resolved with `realpath` containment and opened component by component with
  `O_NOFOLLOW`, so a link planted after extraction is refused. Anything the build skipped is
  `path_not_found`.
- **One place written.** Everything goes under the state directory (`snapshots/` and `tmp/`).
  `semble`'s per-user cache and its token-savings statistics file are pointed below `/dev/null`
  and its cache functions replaced, so nothing is read from or written to a home directory; the
  test suite runs the server with a fresh home and temporary directory and checks both stay empty.
- **Logs carry no content.** One JSON line per request on standard error: the operation, the
  snapshot keys or owner, the status, the outcome and the duration. Never a query, a file path
  or any repository content; `semble`'s own logging and warnings are silenced.

A snapshot and its indexes are a plaintext copy of the repository: the state directory is as
sensitive as the repository itself.

## Running it

```sh
python3 -m vaultgate_code serve --state DIR --model DIR (--socket PATH | --listen HOST:PORT) \
  [--max-snapshots N] [--max-storage-bytes N] [--max-memory-bytes N] [--build-concurrency N]
```

Every flag may instead be set as `VAULTGATE_CODE_<FLAG>` (`VAULTGATE_CODE_STATE`,
`VAULTGATE_CODE_MODEL`, `VAULTGATE_CODE_SOCKET`, `VAULTGATE_CODE_LISTEN`,
`VAULTGATE_CODE_MAX_SNAPSHOTS`, `VAULTGATE_CODE_MAX_STORAGE_BYTES`,
`VAULTGATE_CODE_MAX_MEMORY_BYTES`, `VAULTGATE_CODE_BUILD_CONCURRENCY`); a flag wins, and the
transport is taken whole from one place. `SIGTERM` stops it cleanly, removing the socket.

| Cap                   | Default | Meaning                                                                      |
| --------------------- | ------- | ---------------------------------------------------------------------------- |
| `--max-snapshots`     | 64      | snapshots kept on disk, least recently used evicted first                    |
| `--max-storage-bytes` | 8 GiB   | the sum of every snapshot's trees and indexes on disk                        |
| `--max-memory-bytes`  | 1 GiB   | loaded indexes (measured by resident-memory growth), least recently used out |
| `--build-concurrency` | 1       | build children at once; each needs a few hundred MB while it runs            |

vaultgate reaches it at `VAULTGATE_ACTIONS_CODE_URL`: `unix:` and the socket's absolute path for
the systemd install (the socket is created `0660` in a runtime directory whose group vaultgate's
user belongs to), or an `http://` URL on an internal network for a container (the image listens
on port 8000).

### Installing from the lock

The dependencies are installed from `uv.lock` only, every wheel checked by hash and nothing
resolved at install time:

```sh
uv export --frozen --no-dev --no-emit-project --format requirements-txt -o requirements.txt
python3.12 -m venv venv
venv/bin/pip install --no-cache-dir --require-hashes --no-deps --only-binary :all: -r requirements.txt
PYTHONPATH=src venv/bin/python -m vaultgate_code.fetch_model --dest model
PYTHONPATH=src venv/bin/python -m vaultgate_code serve --socket /run/vaultgate-code/code.sock \
  --state /var/lib/vaultgate-code --model model
```

`fetch_model` uses the standard library alone: it downloads each pinned file at the pinned
revision, stops at the first byte beyond its size, checks its SHA-256 and renames it into place
only when it matches (`--verify-only` checks a directory and downloads nothing). For an offline
install, `pip download --only-binary :all: --no-deps --require-hashes -r requirements.txt -d
wheels` on a connected machine, then add `--no-index --find-links wheels` to the install.

The [Dockerfile](Dockerfile) does the same in an image that runs as a non-root user with a
read-only root filesystem, writing only to its state volume.

### systemd

The sidecar serves correctly under this sandbox (verified with a transient unit), with the state
in a `StateDirectory`, the socket in a `RuntimeDirectory` and a read-only install:
`PrivateNetwork=yes`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX` (the one family it
needs, for its socket; the build child talks over pipes), `ProtectSystem=strict`,
`ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `NoNewPrivileges=yes`, an empty
`CapabilityBoundingSet=`, `SystemCallFilter=@system-service` and `~@privileged @resources`,
`SystemCallArchitectures=native`, `MemoryDenyWriteExecute=yes`, `LockPersonality=yes`,
`RestrictNamespaces=yes`, `RestrictRealtime=yes`, `RestrictSUIDSGID=yes`, the `ProtectKernel*`,
`ProtectControlGroups`, `ProtectClock` and `ProtectHostname` settings, `ProtectProc=invisible`,
`ProcSubset=pid` and `UMask=0027`.

## Tests

```sh
uv sync --frozen
PYTHONPATH=src python3 -m vaultgate_code.fetch_model --dest .model
uv run --frozen ruff check src tests && uv run --frozen ruff format --check src tests
uv run --frozen mypy
uv run --frozen pytest
```

The suite runs the real pinned model and real `semble` and holds 100% line and branch coverage.
It covers the hostile-archive rules, the path rules against real snapshot directories, parity
with `semble`'s own `from_path`, `merge` and `format_results`, eviction, single flight, build
timeouts, start-up reconciliation, the HTTP layer over a Unix socket and TCP, and the command run
as systemd runs it. Set `VAULTGATE_CODE_TEST_MODEL` to use a model directory other than `.model`.
