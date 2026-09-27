# vaultgate code sidecar

The search engine behind vaultgate's `code` connector ([spec 14.8](../../docs/spec/14a-code-connector.md),
[ADR 0008](../../docs/adr/0008-code-search-connector.md)). vaultgate downloads a repository's
archive from GitHub with a token the sidecar never sees and streams it here; the sidecar extracts
it into a **snapshot**, builds [`semble`](https://github.com/MinishLab/semble) indexes over it
(one per content selection, as `semble`'s own MCP server keeps them) and answers
`code_search`, `code_find_related` and `code_read`. It speaks the JSON protocol in
[PROTOCOL.md](PROTOCOL.md) and nothing else.

It is Python 3.12 with one runtime dependency, `semble` 0.6.1 (with `semble-grammars` 0.1.2,
which `semble` requires, pinned beside it), used as a library
(`SembleIndex.from_path`, `merge`, `search`, `find_related`, `save`, `load_from_disk` and
`semble.utils`), never through `semble`'s MCP server or `SembleIndex.from_git`. The embedding
model is `minishlab/potion-code-16M-v2` at the revision pinned in
[`model.json`](src/vaultgate_code/model.json). `semble` chunks source along its syntax tree with
the tree-sitter grammars of `semble-grammars`, which the sidecar reads from a
[grammars directory](#the-grammars-directory) prepared before it runs.

## Security model

- **No credential, no network.** The sidecar never receives a token and never opens an outbound
  connection. It runs with `HF_HUB_OFFLINE=1`, loads the model only from a local directory whose
  every file it checks against the pinned SHA-256 at start-up (and refuses to start on a
  mismatch), loads its tree-sitter grammars only from a directory it verifies the same way, and
  installs a Python audit hook once it is listening that refuses name lookups,
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
  model and grammars directories are only read. The test suite runs the server with a fresh home
  and temporary directory and a read-only grammars directory, and checks all three stay as they
  were.
- **Logs carry no content.** One JSON line per request on standard error: the operation, the
  snapshot keys or owner, the status, the outcome and the duration. Never a query, a file path
  or any repository content; `semble`'s own logging and warnings are silenced.

A snapshot and its indexes are a plaintext copy of the repository: the state directory is as
sensitive as the repository itself.

## Running it

```sh
python3 -m vaultgate_code serve --state DIR --model DIR --grammars DIR \
  (--socket PATH | --listen HOST:PORT) \
  [--max-snapshots N] [--max-storage-bytes N] [--max-memory-bytes N] [--build-concurrency N]
```

`--state`, `--model` and `--grammars` are required. Every flag may instead be set as
`VAULTGATE_CODE_<FLAG>` (`VAULTGATE_CODE_STATE`, `VAULTGATE_CODE_MODEL`,
`VAULTGATE_CODE_GRAMMARS`, `VAULTGATE_CODE_SOCKET`, `VAULTGATE_CODE_LISTEN`,
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
PYTHONPATH=src venv/bin/python -m vaultgate_code.grammars --dest grammars
PYTHONPATH=src venv/bin/python -m vaultgate_code serve --socket /run/vaultgate-code/code.sock \
  --state /var/lib/vaultgate-code --model model --grammars grammars
```

`fetch_model` uses the standard library alone: it downloads each pinned file at the pinned
revision, stops at the first byte beyond its size, checks its SHA-256 and renames it into place
only when it matches (`--verify-only` checks a directory and downloads nothing). For an offline
install, `pip download --only-binary :all: --no-deps --require-hashes -r requirements.txt -d
wheels` on a connected machine, then add `--no-index --find-links wheels` to the install.

The [Dockerfile](Dockerfile) does the same in an image that runs as a non-root user with a
read-only root filesystem, writing only to its state volume. Its model is in
`/opt/vaultgate-code/model` and its grammars in `/opt/vaultgate-code/grammars`, both owned by root.

### The grammars directory

`semble` cuts each file into chunks along its tree-sitter syntax tree, with the grammars of
`semble-grammars`. That package ships every grammar's shared library in an archive inside its
wheel and extracts the one a language needs into a cache directory the first time it is asked
for (`$SEMBLE_GRAMMARS_CACHE_DIR`, otherwise under `$XDG_CACHE_HOME`). The sidecar points every
cache below `/dev/null`, so that nothing is written outside its state directory. If
`semble-grammars` cannot extract a grammar, `semble` logs a warning and falls back to chunking
by lines, and the sidecar silences `semble`'s logs. Up to 0.1.0-rc.21, every index was chunked
by lines this way.

So the grammars are extracted before the sidecar runs, once per install:

```sh
PYTHONPATH=src venv/bin/python -m vaultgate_code.grammars --dest grammars [--verify-only]
```

It writes `grammars/<platform>/`, holding every library `semble-grammars` bundles for the
platform (77 for Linux x86-64). Each is extracted with the package's own extraction, from the
archive in the installed wheel, so nothing is downloaded. Each file is checked against the
SHA-256 in the package's manifest, written `0755` (the directories too) and renamed into place.
Then every file is verified: it must be a regular file, never a link, with the manifest's
SHA-256, and it must load as a grammar. Run again, it re-extracts only what is missing or
damaged. `--verify-only` checks the directory and writes nothing. Extracting takes about 20
seconds, because the package reads its archive afresh for each library; verifying takes under
a second.

`serve --grammars DIR` verifies the directory the same way at start-up. It checks that
`semble`'s own parser lookup finds a parser for Python, TypeScript and Markdown, logs the count
as `grammars` in its `started` line, and reports it in `GET /v1/health`. Only then does it
point `semble-grammars` at the directory, through `SEMBLE_GRAMMARS_CACHE_DIR`, which every build
child inherits. If any of this fails, it logs `start_failed` with the reason and exits 1, so a
sidecar never serves line-chunked indexes because its grammars are missing. Every library is
already in place, so `semble-grammars` never writes to the directory. It should be owned by
root and read-only to the sidecar's user, like the model directory: the libraries are native
code loaded into the sidecar. The flag is required rather than defaulting to a directory beside
the model. It names native code the sidecar loads, as `--model` names the model, and the image
and the systemd unit both pass it. At build time, a bundled grammar that fails to load fails the
build (`build_failed`, `GrammarUnavailable`). A language `semble-grammars` bundles no grammar for
is chunked by lines, exactly as `semble` does.

Each index records the `semble-grammars` version and the sidecar's index format. An index built
by an earlier release records neither, so at start-up it counts as absent. It is rebuilt from
its snapshot the first time a query needs it, without downloading the repository again.

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

The suite runs the real pinned model, the real grammars and real `semble`, and holds 100% line
and branch coverage. It covers the hostile-archive rules, the path rules against real snapshot
directories, eviction, single flight, build timeouts, start-up reconciliation, the HTTP layer
over a Unix socket and TCP, and the command run as systemd runs it. It also covers the grammars
directory: extraction, verification, and refusing a grammar that is tampered with, missing, a
link or that does not load. Parity is checked against `semble` run in a separate process with an ordinary
environment, as its MCP server runs over a checkout. It compares results, lines, scores and
snippets for one repository and for several, over files long enough that chunking by lines
cannot match. The session extracts the grammars once into a temporary directory. Set
`VAULTGATE_CODE_TEST_GRAMMARS` to use a directory extracted beforehand, and
`VAULTGATE_CODE_TEST_MODEL` to use a model directory other than `.model`.
