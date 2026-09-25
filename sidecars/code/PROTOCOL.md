# The `code` sidecar protocol, version 1

vaultgate's `code` connector (spec 14.8, ADR 0008) talks to this sidecar and nothing else does.
The sidecar holds no credential and fetches nothing: vaultgate downloads each repository archive
from the forge and streams it here. The sidecar extracts it under strict rules into a
**snapshot**, builds `semble` indexes over the snapshot on demand (one **variant** per content
selection, exactly as `semble`'s own MCP server keys its cache), and answers searches, related-code
queries and file reads.

## Transport

- HTTP/1.1 served by the Python standard library (`http.server`, threaded), on **either** a Unix
  domain socket (`--socket PATH`, created with mode `0660`, the systemd install) **or** TCP
  (`--listen HOST:PORT`, the Compose and Azure installs, on an internal network only).
- No authentication: placement is the control (an internal network, or a socket only vaultgate's
  group may open). The sidecar never makes an outbound connection and runs with
  `HF_HUB_OFFLINE=1`.
- Requests and responses are UTF-8 JSON (`Content-Type: application/json`) except the archive
  upload of `PUT /v1/snapshots/{key}`. Request bodies other than the archive are capped at
  1 MiB (`413 {"error":"invalid_request"}` beyond).
- Every error is `{"error": <code>, "message": <text>, "detail"?: {...}}` with the status below.
  `message` never contains file content, a query or a path that was not an argument.
- Unknown fields in a JSON body are refused (`400 invalid_request`), and so are a query string,
  a body on `GET` or `DELETE`, a body with both `Content-Length` and `Transfer-Encoding`, and any
  transfer encoding but `chunked`.
- The request line and each header line are at most 64 KiB and a request has at most 100 headers
  (the standard library's limits: `414` or `431`, `invalid_request`); the encoded
  `X-Vaultgate-Build` header must therefore stay under 64 KiB. Path arguments are not
  percent-decoded (no valid key or owner needs encoding).
- A response to a request whose body the sidecar did not read (a `PUT` of an existing key, a
  refused request) carries `Connection: close`; otherwise the connection is kept alive.
- Beside the codes of each operation: `404 not_found` (no such operation),
  `405 method_not_allowed`, and `500 internal_error` (the message is an exception class name
  only).

## Identifiers

| Name      | Rule                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`     | `^[a-z0-9][a-z0-9._-]{0,127}$`: a snapshot, chosen by vaultgate                                                                                       |
| `owner`   | `^[a-z0-9][a-z0-9-]{0,63}$`: the target id the snapshot belongs to                                                                                    |
| `label`   | `^[a-z0-9][a-z0-9-]{0,62}$`: the connection name results are prefixed with                                                                            |
| `commit`  | `^[0-9a-f]{40}$`                                                                                                                                      |
| `content` | a non-empty list drawn from `code`, `docs`, `config`; order and duplicates do not matter; the sidecar normalises it to `code`, `docs`, `config` order |
| language  | `^[A-Za-z0-9_.+#-]{1,64}$`: a `semble` language name, as results carry it                                                                             |

A variant is named by its normalised content joined with `+` (`code`, `docs`, `code+docs+config`).

## Operations

### `GET /v1/health`

`200`:

```json
{
  "protocol": 1,
  "semble": "0.6.1",
  "model": "minishlab/potion-code-16M-v2",
  "model_revision": "<40-hex Hugging Face commit>",
  "python": "3.12.x",
  "limits": {
    "max_snapshots": 64,
    "max_storage_bytes": 0,
    "max_memory_bytes": 0,
    "build_concurrency": 1
  },
  "usage": {
    "snapshots": 0,
    "storage_bytes": 0,
    "loaded_variants": 0,
    "loaded_bytes": 0,
    "building": 0
  }
}
```

### `PUT /v1/snapshots/{key}`: build

Body: the gzip tar archive exactly as the forge sent it, streamed (`Content-Length` or chunked).
Header `X-Vaultgate-Build`: the build spec, base64url (no padding) of this JSON:

```json
{
  "owner": "3f0c…",
  "commit": "<40 hex>",
  "include": ["gitignore-syntax pattern", "…"],
  "exclude": [".env", "…"],
  "max_archive_bytes": 268435456,
  "max_files": 50000,
  "max_total_bytes": 1073741824,
  "max_file_bytes": 1048576,
  "build_timeout_s": 600,
  "variants": [["code", "docs", "config"]]
}
```

`include` and `exclude` each hold at most 100 patterns of 1 to 1 024 characters, each a single
line and each a valid gitignore pattern; an empty `include` includes everything. `variants` (0–4
entries, duplicates dropped) are built before the response; the others are built on demand by
search and related (below). The sidecar accepts `max_archive_bytes` up to 1 GiB, `max_files` up to
200 000, `max_total_bytes` up to 4 GiB, `max_file_bytes` up to 64 MiB and `build_timeout_s` up to
3 600, each at least 1.

Rules, each failing the whole build with the named code and leaving any existing snapshot of the
same key untouched:

- The compressed bytes read are capped at `max_archive_bytes` (`archive_too_large`). The
  decompressed bytes read, headers and skipped members included, are capped at
  `max_total_bytes + 64 MiB` (`archive_too_large`: the decompression-bomb guard). Members are
  counted, skipped ones included, and more than `2 × max_files + 1000` is `archive_too_large`.
- Exactly one top-level directory (GitHub's `owner-repo-sha/`) is stripped; none, or more than
  one, is `archive_invalid`. A pax global header is not a member.
- A member name that is absolute, has a `..` segment, a backslash or a NUL, or is longer than
  1 024 bytes (after stripping) is `archive_invalid`.
- Only regular files and directories are written. Symbolic links, hard links, character and block
  devices and FIFOs are skipped and counted (`skipped.links`, `skipped.special`), never created.
- `include`, then `exclude` (gitignore syntax, matched on the stripped POSIX path; a pattern that
  matches a directory excludes everything beneath it) are applied before a file is written;
  `skipped.excluded` counts what they removed. A file larger than `max_file_bytes` is not written
  (`skipped.large`).
- More than `max_files` written files, or more than `max_total_bytes` written bytes, is
  `archive_too_large`.
- Python's `tarfile` data filter is applied as well as these rules, never instead of them. Files
  are written `0644` (directories `0755`) whatever the archive says; modification times are
  kept.
- Each requested variant is then built with `semble`'s `SembleIndex.from_path` over the snapshot
  tree in a child process, killed at `build_timeout_s` (`build_timeout`). A tree with nothing
  `semble` can index for a variant gives that variant `chunks: 0` rather than failing the build.
  Any other failure is `build_failed` (the message is the exception class name only).
- The snapshot is assembled in a temporary directory under the state directory and renamed into
  place atomically. Before the rename the sidecar evicts least-recently-used snapshots (never one
  in use by a running request or build) until the new one fits within `max_snapshots` and
  `max_storage_bytes`; if it cannot fit even then, `507 storage_full`.
- A `PUT` for a key that already exists answers `200` with its metadata without reading the
  body (the header is still validated). A `PUT` for a key whose build is already running waits
  for that build and answers with its result (single flight); its own body is discarded.
- A `PUT` whose key is deleted while it builds answers `404 snapshot_missing`.

`200`: the snapshot's metadata (below). `400 invalid_request` for a malformed key, header or spec;
`422` with `archive_invalid`, `archive_too_large`, `build_timeout` or `build_failed` and
`detail` holding the counts so far (`members`, `files`, `bytes`, `skipped`), with `variant` naming
the variant for `build_timeout` and `build_failed`; `507 storage_full` (also when the disk fills
during extraction).

### Snapshot metadata

```json
{
  "key": "…",
  "owner": "…",
  "commit": "<40 hex>",
  "created_at": 1790000000000,
  "last_used_at": 1790000000000,
  "files": 1050,
  "bytes": 12582912,
  "skipped": { "links": 0, "special": 0, "excluded": 3, "large": 1 },
  "storage_bytes": 51380224,
  "variants": {
    "code+docs+config": {
      "files": 1050,
      "chunks": 19921,
      "built_at": 1790000000000,
      "duration_ms": 28400,
      "storage_bytes": 38797312
    }
  }
}
```

Times are milliseconds since the epoch. `files` and `chunks` of a variant are `semble`'s own
counts (`stats.indexed_files`, `stats.total_chunks`).

### `GET /v1/snapshots`

`200 {"snapshots": [metadata, …], "building": [{"key", "owner", "started_at"}]}`.

### `GET /v1/snapshots/{key}`

`200` metadata; `202 {"state": "building", "started_at": …}` while its build runs;
`404 snapshot_missing`.

### `DELETE /v1/snapshots/{key}` and `DELETE /v1/owners/{owner}`

Delete one snapshot, or every snapshot of an owner (a deleted target). A running build of a
deleted key is abandoned and its result discarded. Idempotent: `200 {"deleted": n}`.

### `POST /v1/search`

```json
{
  "indexes": [{ "key": "…", "label": "claude-setup" }],
  "content": ["docs"],
  "query": "where is fleet_deploy triggered",
  "top_k": 5,
  "max_snippet_lines": 10,
  "paths": ["optional exact repo-relative file paths"],
  "languages": ["optional semble language names"]
}
```

- `indexes`: 1–10 entries, keys and labels each unique. `query`: 1–1 000 characters. `top_k`:
  1–200. `max_snippet_lines`: an integer ≥ 0 or `null`. `paths` and `languages`: at most 20 each
  (passed to `semble` as `filter_paths` and `filter_languages`; with several indexes a path
  carries its label prefix, as the results do).
- A variant not yet built is built first (single flight per key and variant, in a child process,
  under the global build concurrency) and the request waits for it; the caller bounds the wait
  by its own timeout, and an abandoned request does not cancel the build.
- One index is searched as it is. Several are merged with `SembleIndex.merge` exactly as
  `semble`'s MCP server merges repositories, the label standing for the repository name, so every
  `file_path` is `<label>/<path>`; the merged index is cached while its parts stay loaded.
- `404 snapshot_missing` (`detail.key`) when a key has no snapshot or it is deleted while its
  variant builds; a variant that cannot be built answers as a build does (`422 build_timeout` or
  `build_failed` with `detail.variant`, `507 storage_full`).

`200`:

```json
{
  "results": [
    {
      "label": "claude-setup",
      "file_path": "memory/x.md",
      "start_line": 35,
      "end_line": 52,
      "score": 0.83,
      "language": "markdown",
      "content": "…"
    }
  ],
  "variants": [{ "key": "…", "variant": "docs", "chunks": 19921, "built_at": 1790000000000 }]
}
```

`content` follows `semble`'s `format_results`: `null` gives the whole chunk, `0` leaves the field
out, `N` gives the chunk's first `N` lines. `score` is a JSON number. `language` is `semble`'s
language of the chunk, or `null`. An empty result list is `200` with `results: []`. `variants`
lists each index read, in the order of `indexes`.

### `POST /v1/related`

`{"indexes", "content", "file_path", "line", "top_k", "max_snippet_lines"}` with the same rules;
`file_path` obeys the path rules below (with several indexes it starts with a label) and `line`
is ≥ 1. The seed chunk is found with `semble`'s own rule (the chunk of that file containing the
line, preferring one the line is not the last line of) and passed to `find_related`.
`404 chunk_not_found` when no chunk holds that line (or the variant has no chunks). `200` as for
search; `results` may be empty when nothing is related.

### `POST /v1/read`

`{"key", "file_path", "start_line"?, "end_line"?, "max_lines"}`: `start_line` ≥ 1 (default 1),
`end_line` ≥ `start_line` (default: the last line; an earlier one is `400 invalid_range`),
`max_lines` 1–2 000.

`200`:

```json
{
  "file_path": "src/x.ts",
  "start_line": 1,
  "end_line": 400,
  "total_lines": 1200,
  "text": "…",
  "truncated": true
}
```

The file is decoded as UTF-8 with replacement characters; lines are split as `str.splitlines()`
does and joined with `\n`. The range returned is `start_line` to
`min(end_line, total_lines, start_line + max_lines - 1)`; `truncated` is true when that stops
before `min(end_line, total_lines)`. A `start_line` beyond `total_lines` is
`400 invalid_range` (an empty file answers `start_line: 1, end_line: 0, text: ""`). A file with a
NUL byte in its first 8 KiB is `422 not_text`.

### Path rules (search `paths`, related, read)

A `file_path` is a repository-relative POSIX path. An absolute path, a `..`, `.` or empty
segment, a backslash, a NUL, or more than 1 024 bytes is `400 invalid_path`. For read, the path
is resolved inside the snapshot tree and anything whose resolved path leaves it, or that is not
a regular file there, is `404 path_not_found` — including every file the build skipped or
excluded, whether or not the repository has it.

## Storage and memory

- State directory layout: `snapshots/<key>/meta.json`, `snapshots/<key>/tree/…`,
  `snapshots/<key>/variants/<variant>/` (a `semble` `save()`), `tmp/` for builds in progress
  (emptied at start-up). Nothing else is written; `semble`'s own cache folder and statistics file
  are pointed at a location where they can neither be read nor written.
- A variant records the `semble` version, the model id and revision and `semble`'s cache format
  version; one built with any other is treated as absent and rebuilt. A variant loads correctly
  after the install moves (the model path stored in `semble`'s metadata is not trusted).
- **Disk:** at most `max_snapshots` snapshots and `max_storage_bytes` bytes (the sum of every
  snapshot's `storage_bytes`), least recently used first out. `last_used_at` is updated by every
  search, related and read.
- **Memory:** loaded variants (and the cached merge) stay in memory while their estimated size
  (the growth in resident memory measured when each was loaded, and at least its size on disk)
  sums to at most `max_memory_bytes`; the least recently used are dropped first, and
  `malloc_trim` is called after a drop. A variant larger than the whole budget is still served,
  alone.
- Start-up reconciles: temporary directories are removed, snapshots with unreadable metadata are
  deleted, and the caps are enforced once.
