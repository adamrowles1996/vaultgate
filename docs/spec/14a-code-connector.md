# 14a The `code` connector

> **Status: planned for M16.** Section 14.8 of [14 Action connectors](14-actions-connectors.md),
> kept in a file of its own. Decided in [ADR 0008](../adr/0008-code-search-connector.md) and
> amended on 2026-09-25 for parity with `semble`'s own MCP server (14.8.6). Requirement
> identifiers continue the `ACT-n` sequence of section 13.

## 14.8 `code`

A `code` target is a GitHub repository. vaultgate fetches snapshots of it with a read-only token
from the vault, a sidecar builds `semble` search indexes over each snapshot, and the agent
searches and reads them through `code_search`, `code_find_related` and `code_read` (13.6.7). The
two search tools do what `semble`'s own MCP server's `search` and `find_related` do, for the
repositories an operator configured (14.8.6). The console shows the kind as **Semble · GitHub
code search** and a target of it as a _Semble connection_; the connector id stays `code` and the
scope `actions:code`.

The trust an operator extends by granting a code target is **read access to that repository**,
at any commit when the policy allows a per-call `ref` (the default) and at the configured ref
only when it does not, including every file the policy does not exclude.

| Document      | Fields                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `destination` | `forge` (`github`; the only value in M16); `repository` (`owner/name`, each part `^[A-Za-z0-9._-]{1,100}$`, neither `.` nor `..`); `ref` (optional: a branch or tag name, or a full 40-hex commit SHA; absent means the repository's default branch, looked up at each freshness check).                                                                                                         |
| `credential`  | `token_field`: the vault field holding the token, `password` by default and any field the item carries (a hidden custom field included), or `null` for a public repository read without a token. The guide asks for a fine-grained token with `Contents: read` and `Metadata: read` and nothing else; one token may cover every repository of one owner and serve a connection for each of them. |
| `policy`      | The common fields, `timeout_ms` defaulting to 150 000 here; `refresh_interval_s` (300 default, 60 to 86 400); `content` (a non-empty subset of `code`, `docs` and `config`, all three by default); `allow_ref` (`true` default); `max_top_k` (50 default, ceiling 200); `build_wait_s` (90 default, ceiling 290, and at most `timeout_ms` less 10 s); `include` and `exclude` (below).           |
|               | The caps: `max_archive_bytes` (256 MiB default, ceiling 1 GiB); `max_files` (50 000 default, ceiling 200 000); `max_total_bytes` (uncompressed, 1 GiB default, ceiling 4 GiB); `max_file_bytes` (1 MiB default, ceiling 16 MiB); `build_timeout_s` (600 default, ceiling 3 600). Reading: `allow_read` (`true` default) and `max_read_lines` (400 default, ceiling 2 000).                       |

`include` and `exclude` are gitignore-syntax pattern lists of at most 100 entries each;
`exclude` defaults to ACT-106's list.

### 14.8.1 Fetching

- **ACT-103** `endpoints()` of a `github` destination returns `api.github.com` and
  `codeload.github.com`, both over TLS; `internal` MUST be `false`. Both hosts are resolved,
  validated and pinned per call (ACT-55, ACT-56) and verified against the system store (ACT-57).
  The token is sent as `Authorization: Bearer` to `api.github.com` only, and not at all when
  `token_field` is `null`.
- **ACT-104** A fetch resolves a ref to a commit first, then downloads that commit:
  - no ref (the default branch): `GET /repos/{repository}`, whose `default_branch` is then
    resolved as a branch;
  - a branch or tag: `GET /repos/{repository}/commits/{ref}` with
    `Accept: application/vnd.github.sha`, whose body is the 40-hex SHA;
  - a 40-hex SHA: used as it is (the download proves it exists);
  - `pr:<n>`, which only a call may name (ACT-110): `GET /repos/{repository}/pulls/{n}`, whose
    `head.sha` is the commit; a pull request from a fork is still served from the base
    repository, which holds its head.

  A `404` or `422` from a resolution is `ref_not_found`; any other failure, or a body that is not
  what the step expects, is `upstream_error`. The archive is `GET /repos/{repository}/tarball/{sha}`,
  so the snapshot is exactly the commit it is labelled with. vaultgate follows **one** redirect,
  and only to an `https://codeload.github.com/` URL whose path begins with `/{repository}/`,
  compared case-insensitively because GitHub redirects to the repository's canonical name; any
  other redirect, or a second one, is `upstream_error`. `Authorization` is never sent to
  `codeload.github.com`. The redirect URL carries a short-lived token of its own, so it joins the
  call's injected values (ACT-50) and is scrubbed, never logged and never audited. A ref name is
  1 to 255 characters of `[A-Za-z0-9._/-]` with no `..` segment and no leading or trailing `/`,
  and is percent-encoded into the path.

- **ACT-105** The archive is streamed from the forge to the sidecar's build request as it
  arrives. vaultgate neither decompresses it nor writes it to disk, and it cuts the stream at
  `max_archive_bytes`, which fails the build with `archive_too_large`. Nothing from the archive
  reaches vaultgate's data directory, database, logs or audit rows.

### 14.8.2 Snapshots and indexes

- **ACT-106** The sidecar extracts the gzip tar into a new snapshot under these rules, and a
  build that breaks one fails as a whole with the named reason:
  - The single top-level directory GitHub adds is stripped; an archive without exactly one is
    `archive_invalid`.
  - Regular files and directories are the only entries written. Symbolic links, hard links,
    devices and FIFOs are skipped and counted, never created.
  - An entry name that is absolute, contains a `..` segment, a backslash or a NUL, or is longer
    than 1 024 bytes is `archive_invalid`.
  - `include` and then `exclude` are applied to each entry before it is written, so an excluded
    file never exists in the snapshot. The default `exclude` is `.env`, `.env.*`, `*.pem`,
    `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*.kdbx`, `.git-credentials`, `.netrc`
    and `.npmrc`. An operator who replaces the list replaces the defaults too, and the page
    says so. A file larger than `max_file_bytes` is skipped and counted.
  - Exceeding `max_files` or `max_total_bytes` is `archive_too_large`, and so is a stream that
    decompresses to more than `max_total_bytes` plus 64 MiB whatever it writes (the
    decompression-bomb guard).

  The extractor uses Python's `tarfile` data filter as well as these rules, never in place of
  them. The wire rules are in [`sidecars/code/PROTOCOL.md`](../../sidecars/code/PROTOCOL.md).

- **ACT-107** A **snapshot** is one target at one commit under one extraction policy; an
  **index** is a snapshot searched for one content selection, built with `semble`'s
  `SembleIndex.from_path` over the snapshot in a child process of the sidecar and saved beside
  it, exactly as `semble`'s MCP server keeps one index per repository and content selection.
  An index is built the first time a call or build asks for its selection and is kept after.
  A build that fails or exceeds `build_timeout_s` changes nothing already built, and its reason
  is shown to the operator. The sidecar keeps at most `max_snapshots` snapshots and
  `max_storage_bytes` bytes on disk and drops the least recently used first; it keeps loaded
  indexes in memory within `max_memory_bytes`, least recently used out first, and loads a dropped
  one again from disk when it is next asked for. The limits belong to the sidecar's deployment
  (ACT-114), not to a target.
- **ACT-108** Builds happen at three points, never on a timer:
  - When an enabled target is saved, including by a new revision: the configured ref's snapshot
    and the index of the policy's whole `content`, in the background (trigger `save`). A
    revision that changes the destination, `token_field`, `content`, `include`, `exclude` or a
    cap first deletes every snapshot of the target, so no call answers from a snapshot the current
    policy would not have produced.
  - When the operator presses **Rebuild index** on the target's page: every snapshot of the
    target is deleted and the configured ref is built again (trigger `operator`). This needs the
    operator session and CSRF token; it is not a target write, so ID-15's re-authentication does
    not apply.
  - When a call needs a snapshot or an index that does not exist (trigger `call`); the call waits
    for it (ACT-112). The configured ref is resolved again when its last resolution is older than
    `refresh_interval_s`. If it moved and the previous commit's snapshot exists, the call is
    answered from that snapshot with `stale: true` while the new one builds in the background. A
    failed resolution with a snapshot to answer from never fails the call; it is recorded on the
    target page and in the audit trail. A ref a call names is resolved on every call, except a
    40-hex SHA, which never moves.

  One build runs per target and commit at a time; a second trigger while one runs joins it.

- **ACT-109** Deleting a target tells the sidecar to delete every snapshot of it before the row is
  removed; an unreachable sidecar does not block the deletion. Whenever vaultgate starts or finds
  the sidecar reachable again, it deletes every snapshot whose target no longer exists or whose
  extraction policy is no longer the target's, so a target that no longer exists has no index.
  A sidecar that loses its storage loses nothing but time: the next call builds again.

### 14.8.3 Tools

- **ACT-110** The three tools take `repo` in place of `target` (ACT-16): the name of a code
  target, or for the two search tools a list of 1 to 10 distinct names, searched together.
  - `code_search`: `query` (1–1 000 characters); `repo`; optional `ref`; optional `content`
    (`code`, `docs`, `config` or `all`); `top_k` (1–200, default 5); `max_snippet_lines` (an
    integer 0–1 000 or `null`, default 10); optional `paths` and `languages` (at most 20 each,
    passed to `semble` as its path and language filters).
  - `code_find_related`: `file_path` and `line` (a location from a search result); `repo`;
    optional `ref` and `content`; `top_k` and `max_snippet_lines` as above.
  - `code_read`: `repo` (one name); `file_path`; optional `ref`, `start_line` and `end_line`
    (inclusive, 1-based).

  `ref` is a branch, a tag, a 40-hex SHA or `pr:<n>`; it may be given with one `repo` only, and
  it is `policy_denied` (`reason: ref`) when the target's `allow_ref` is `false`. `content`
  defaults to every type the policy's `content` allows; `all` means the same; a single type the
  policy does not allow is `policy_denied` (`reason: content`). With several repositories the
  selection is the types every one of their policies allows, and a selection none of them
  shares is `policy_denied` (`reason: content`). A `top_k` above a target's `max_top_k` is
  `policy_denied` (`reason: top_k`). `code_read` is `policy_denied` (`reason: read`) when
  `allow_read` is `false`.

  Both search tools return `{ query, results, repos }`. Each result is
  `{ repo, file_path, start_line, end_line, score, language, content? }`, ranked as `semble`
  ranks it; `content` follows `semble`'s rule (`max_snippet_lines` `0` leaves it out, `N` gives
  the chunk's first `N` lines, `null` the whole chunk), and with several repositories every
  `file_path` begins with the repository's connection name and a `/`, as `semble` prefixes
  merged results. `repos` lists, per repository, `{ repo, repository, ref, commit, indexed_at,
stale }`. `code_read` returns `{ repo, commit, file_path, start_line, end_line, total_lines,
text, truncated }`, at most `max_read_lines` lines. Every result passes the engine's scrubber
  (ACT-51); a search result that would pass `max_output_bytes` loses results from the end, with
  `truncated: true`, and a read's `text` is cut at the cap (ACT-52).

- **ACT-111** Every `file_path` argument is a repository-relative POSIX path; for a search over
  several repositories, `code_find_related`'s begins with a connection name, as that search's
  results do. An absolute path, a `..`, `.` or empty segment, a backslash, a NUL, or more than
  1 024 bytes is `invalid_arguments`. A path that is not a regular file in the snapshot,
  including every excluded or skipped file, is `path_not_found`, whether or not the repository
  contains it; a line that no indexed chunk holds is `chunk_not_found`. The sidecar resolves the
  path inside the snapshot and refuses anything whose resolved path leaves it. A file with a NUL
  byte in its first 8 KiB is `not_text` for `code_read`.
- **ACT-112** A call whose snapshot or index does not exist yet waits for its build for up to
  `build_wait_s` (the smallest of its repositories'), as `semble`'s MCP server indexes a
  repository on its first call. After that it answers `index_not_ready` with `detail.state`
  `building` and `detail.repo`; the build carries on and a later call finds it. A build that
  failed answers `index_not_ready` with `detail.state` `failed` and the reason code in
  `detail.reason` (never a message); the operator's page shows the rest. `actions_list_targets`
  reports a code target's `repository`, its configured `ref` (absent for the default branch),
  the `content` it allows, whether `code_read` is allowed (`read`) and `read` as its only
  operation (ACT-19).

### 14.8.4 Sidecar

- **ACT-113** The index is never built or searched in the vaultgate process or image. The
  sidecar is built from `sidecars/code/` in this repository:
  - It runs Python 3.12 with dependencies locked by hash (`uv`), `semble` pinned to an exact
    version, and the `minishlab/potion-code-16M-v2` model at a pinned revision, downloaded at
    build time and checked by SHA-256. It runs with `HF_HUB_OFFLINE=1`.
  - It is released and signed with the core release, as an image and as a bundle for the
    systemd install, and scanned the same way.
  - It serves the JSON protocol of `sidecars/code/PROTOCOL.md` over HTTP with the Python
    standard library's server, on a Unix domain socket or on an internal interface only. The
    protocol has seven operations: `health`, `build`, `status`, `search`, `related`, `read` and
    `delete`.
  - It uses `semble` as a library only, never its MCP server or `SembleIndex.from_git`.
  - It never receives a credential. It holds no state beyond its snapshots and indexes, and loses
    none it cannot rebuild.

  vaultgate reaches it at `VAULTGATE_ACTIONS_CODE_URL`, an `http://` URL on an internal address
  or `unix:` followed by the absolute path of the socket, validates every response against a
  schema, and treats an unreachable sidecar as `index_unavailable`.

- **ACT-114** There are three placements, each keeping the sidecar away from the internet and
  from `bw serve`'s unauthenticated loopback (ACT-56):
  - **Compose:** an optional `code` service under a `code` profile, on an internal network
    (`internal: true`) shared only with `vaultgate`, so it has no route to the internet or the
    host. It has no published port, `cap_drop: [ALL]`, `no-new-privileges`, a read-only root
    filesystem with `tmpfs` for `/tmp`, a named volume for its state, a memory limit (2 GiB
    default) and a `pids` limit.
  - **systemd** (`install.sh --with-code-sidecar`): its own unit and its own system user, a state
    directory outside vaultgate's data directory, and a Unix socket that only vaultgate's group
    may open. The unit runs with `PrivateNetwork=yes`, `IPAddressDeny=any` and
    `RestrictAddressFamilies=AF_UNIX`, so it has no network interface but a loopback of its own,
    together with the rest of systemd's sandboxing (`ProtectSystem=strict`, `ProtectHome`,
    `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, an empty capability bounding set, a
    system-call filter) and memory and task limits.
  - **Azure:** a separate Container App in the same environment with internal-only ingress and
    ephemeral storage, deployed when `deployCodeSidecar` is `true`. It is never a second container
    of vaultgate's app, because the containers of one app share a network namespace and `bw serve`
    listens on its loopback. An Azure environment without VNet integration cannot deny the
    sidecar egress; the threat model records that.

- **ACT-115** With the connector enabled, vaultgate calls `health` at start-up and logs the
  sidecar's protocol version, `semble` version and model id; an incompatible protocol version
  disables the connector's tools with a start-up error rather than failing calls one by one. The
  target page shows, for each code target:
  - each snapshot's commit, the ref it was built for, the build time and the trigger;
  - its indexes, with their file and chunk counts, and its skip counts;
  - the last resolution of the configured ref;
  - the reason for the last failure;
  - the **Rebuild index** button.

### 14.8.5 Operator pages

- **ACT-119** The Add connection page offers **Semble · GitHub code search** as its own kind,
  and the Connections list groups code targets under it. After the vault item (ACT-5) the form
  asks for the name agents will use, the description, the repository, the ref (the default
  branch when empty), the content types, `include` and `exclude`, whether `code_read` is
  allowed, and the caps. The token field defaults to `password` and lists the item's fields,
  hidden custom fields included, with a choice of no token for a public repository. The
  repository field lists every repository the chosen token can read (`GET /user/repos`, 100 per
  page and at most 10 pages, through the pinned transport of ACT-55 to ACT-57 with the token
  injected server-side), and takes a typed `owner/name` instead. This page and ACT-120 are the
  only places a page uses a secret: the token is fetched inside the ID-15 window, sent to
  `api.github.com` only and never drawn, and a failure shows its code, scrubbed.
- **ACT-120** **Check without saving** (ACT-118) of a code target also asks GitHub for the
  repository (`GET /repos/{repository}`) with the chosen token, and shows whether the token can
  read it, its default branch and its visibility, never the token. A public repository answers
  without one.

### 14.8.6 Parity with `semble`'s MCP server

`semble` 0.6.1's MCP server offers `search(query, repo, top_k=5, content, max_snippet_lines=10)`
and `find_related(file_path, line, repo, top_k=5, content, max_snippet_lines)`, where `repo` is
one repository or a list and `content` is `code`, `docs`, `config` or `all`. `code_search` and
`code_find_related` take the same arguments with the same defaults and meaning, rank with the
same library, format content by the same rule and prefix merged results the same way, with three
differences:

| `semble` MCP                                                  | vaultgate                                                                           | Why                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `repo` is a local path or any `https://` or `http://` git URL | `repo` is a connection name; the operator chose the repository, and it is on GitHub | ADR 0004: the agent never chooses what the host reads or fetches. Local paths and other forges are the parity gaps. |
| merged results carry the repository directory's name          | merged results carry the connection name                                            | the agent knows the repository by that name                                                                         |
| `content` defaults to the server's configuration (`code`)     | `content` defaults to every type the policy allows                                  | the operator's policy is the configuration                                                                          |

vaultgate adds what `semble` has no need of: `ref`, `code_read`, the `paths` and `languages`
filters, and the `commit` and `stale` of each repository. The tool descriptions and the handshake
instructions (MCP-16) carry `semble`'s own guidance: search once with a focused query, go
straight to the returned file and line, use `code_find_related` after a search, and ask for
`max_snippet_lines: null` when a snippet is not enough.

### 14.8.7 Audit and verification

- **ACT-116** Calls are audited per ACT-60, one row per repository, with operation `read` and
  classification `search`, `related` or `read`; `arguments` records the query, the path and the
  line numbers. A build is an audit event (`actions.code_index_built` or
  `actions.code_index_failed`) carrying the target, the commit, the content selection, the
  trigger (`save`, `operator` or `call`), the counts, the duration and, on failure, the reason
  code. No file name beyond the arguments, and no content, is ever recorded.
- **ACT-117** The sidecar has its own test suite at 100% coverage. It runs hostile archives
  (links, `..` names, devices, a decompression bomb, oversize and overcount archives, a missing
  top-level directory) and the path rules of ACT-111 against real snapshot directories, and it
  compares its results with `semble`'s own for one repository and for several.

  vaultgate's contract suite runs against a fake forge and a fake sidecar. It asserts:
  - the resolve-then-download sequence for every kind of ref;
  - the single-redirect rule and that `Authorization` never reaches `codeload.github.com`;
  - the stream cap;
  - single-flight builds, the wait of ACT-112 and `stale: true`;
  - deletion on target removal and the reconciliation of ACT-109;
  - the ACT-53 canary over every tool result, audit row and log line.

  The live test of M16 indexes the maintainer's private repositories through the systemd sidecar
  and answers the same queries as `semble`'s own MCP server over a clone of the same commit,
  recorded in the milestone pull request.
