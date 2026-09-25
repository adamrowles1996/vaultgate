# 13a Actions in operation: network, limits, audit, storage and architecture

> **Status: as [13 Actions](13-actions.md), of which this is the second half.** Section 13
> specifies what a target is, who may use it, what the tools are, how a call is judged and how a
> human confirms it; this file specifies how a deployment runs, bounds, records, stores and
> verifies that layer. The section numbers and the `ACT-n` sequence continue from 13 without a
> break, so a citation such as §13.16 or ACT-74 means the same thing wherever it is written.
> The two files exist because one had outgrown the repository's file-size gate (11.1), not
> because the subject divides in two.

## 13.10 Destinations and network

- **ACT-55** Every connector resolves the destination host name once per call through the
  resolver of OAUTH-8, validates every returned address against the private-range rule, and
  connects to the validated address with the host name reserved for TLS (SNI and certificate
  verification), the HTTP `Host` header and SSH host-key lookup. The name is never resolved a
  second time (no rebinding window). IP-literal destinations skip resolution and are validated the
  same way. The `browser` connector cannot pin (Chromium resolves names itself); its controls are
  14.7's origin confinement, request interception and network placement, and the difference is
  stated in the threat model.
- **ACT-56** Private-range rule: RFC 1918, CGNAT (`100.64/10`), unique-local IPv6 and IPv4-mapped
  forms are refused unless the target is `internal: true`. Loopback (`127/8`, `::1`), link-local
  (`169.254/16`, `fe80::/10`, which covers cloud metadata endpoints), multicast and unspecified
  addresses are refused always, whatever `internal` says: `bw serve` listens on loopback and an
  `http` target reaching it would be a path from a token to the whole vault.
- **ACT-57** TLS is required unless the destination allows plain transport under `internal: true`
  (section 14), and certificate verification uses the system store or the pin the destination
  document provides. There is no "ignore certificate errors" option; a failed verification is
  `tls_error`.
- **ACT-58** Connections are opened after the policy decision and closed at the end of the call;
  the engine keeps no connection, agent or shell across calls. The one exception is a browser
  session (14.7), which is bounded, bound to one client and closed by every revocation path. A
  process restart loses nothing but the adapter token cache and open browser sessions.

## 13.11 Rate limits and caps

| Limit                       | Default                                                                         | Key     | Beyond it                                                      |
| --------------------------- | ------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------- |
| Calls per target            | `policy.rate_limit_per_minute`, 60                                              | target  | `rate_limited` with `retry_after_s`                            |
| Calls per client            | 120 / min across all targets                                                    | client  | `rate_limited`                                                 |
| In-flight calls per target  | 4                                                                               | target  | `rate_limited`                                                 |
| In-flight calls per client  | 8                                                                               | client  | `rate_limited`                                                 |
| Timeout per call            | `policy.timeout_ms`, 30 000; ceiling 300 000                                    | call    | `timeout`; the connector cancels the work                      |
| Output per call             | `policy.max_output_bytes`, 256 KiB; ceiling 1 MiB                               | call    | `truncated: true`                                              |
| Request body (`http`)       | `policy.max_body_bytes`, 256 KiB; ceiling 4 MiB                                 | call    | `policy_denied` (`body_size`)                                  |
| Rows (`sql_query`)          | `policy.max_rows`, 500; ceiling 10 000                                          | call    | `truncated: true`                                              |
| Browser sessions per client | `policy.max_sessions`, 1; ceiling 4                                             | client  | `session_limit`                                                |
| Browser session lifetime    | `policy.session_ttl_s`, 900 idle; 3 600 absolute                                | session | `session_expired`                                              |
| Confirmations pending       | 2 minutes each                                                                  | state   | `confirmation_expired`                                         |
| Index builds (`code`)       | 1 in flight per target and commit; `policy.build_timeout_s`, 600; ceiling 3 600 | target  | A second trigger joins the running build (ACT-108)             |
| Build wait (`code`)         | `policy.build_wait_s`, 90; ceiling 290                                          | call    | `index_not_ready` (`building`), the build carries on (ACT-112) |

- **ACT-59** Limits are the in-memory token buckets of OPS-6 (single replica, 10 000 keys), sit
  inside the per-token limit of MCP-5, and are applied before confirmation so an agent cannot
  spend confirmations to probe them. A rate-limited call is audited with outcome
  `denied:rate_limited`.

## 13.12 Audit

- **ACT-60** Every call appends the MCP-13 audit event (tool, client, token prefix, outcome,
  duration) **and** one `action_calls` row: `id`, `at`, `target_id`, `target_name`, `connector`,
  `revision`, `tool`, `session_id_hash` (the SHA-256 of the browser session id, ACT-96), `client_id`, `token_prefix`, `operation` (`read` \|
  `write` \| `shell` \| `act`), `classification` (SQL class, HTTP method, `command` — the whole command on an
  any-command target, which ACT-88 requires and the 4 KiB cap on `arguments` could otherwise cut
  — or the browser
  page URL), `arguments` (JSON of the tool arguments minus injected values and minus any header
  the policy did not allow, capped at 4 KiB with `arguments_truncated`; a capped value carries a
  trailing `[vaultgate: <n> of <m> bytes shown; sha256 of the whole is <hex>]`, so the ACT-63
  view shows an operator that it is reading part of a record and gives them something to check
  the rest against — `ssh` and `winrm` also have ACT-88's full command in `classification`, and
  a 64 KiB `sql` statement has nothing else), `output_bytes`,
  `output_truncated`, `duration_ms`, `outcome` (`ok` \| `denied:<code>` \| `error:<code>`),
  `elicitation` (`not_required` \| `accepted` \| `declined` \| `cancelled` \| `unavailable` \|
  `invalid`), `confirmation_nonce`, `request_id`, `ip`. Results, snapshots and screenshots are
  never stored. A call that ends in a confirmation request (ACT-42) records nothing yet: the
  retry that carries the answer is the call that is recorded.
- **ACT-61** Arguments are stored because an operator who finds an unexpected write needs to see
  the statement, command or typed text that ran, and because the agent supplied them in the
  clear; the scrubber still runs over them (a prompt-injected agent could echo a value it obtained
  elsewhere).
- **ACT-62** `action_calls` rows are append-only from the application's point of view, retained
  for `VAULTGATE_AUDIT_RETENTION_DAYS` like `audit_events` (MCP-15, STORE-6), and included in the
  audit export (OPS-5) as a second stream (`--stream actions`; the Activity page's export offers both).
  The one exception is a call's own row: it is reserved (outcome `error:interrupted`, the nonce
  consumed) before the connector runs and completed with the outcome, output size and duration
  when the call ends. That completion is the only update path, and nothing deletes a row before
  retention.
- **ACT-63** A target's page shows its last 50 calls with their outcome and elicitation result,
  and its open sessions. The console's Activity page shows the latest calls across targets and
  links to an "unexpected write" view listing every non-read call whose elicitation is not
  `accepted`, so a target with `confirm_writes: false` is reviewable; the Connections page and the
  sidebar count those of the last seven days.

## 13.13 Storage

Migration `004-actions` adds four tables (conventions of 07.1). Migration `005-code-connector`
(M16, ADR 0008) rebuilds `action_targets` with the same columns to widen its `connector` `CHECK`
to admit `code`, because SQLite cannot alter a `CHECK` in place; no column is added, and nothing
about a repository, snapshot or index is stored in vaultgate's database:

| Table             | Columns                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action_targets`  | `id`, `name` (unique), `description`, `connector`, `destination` (JSON), `internal`, `credential` (JSON: item id and field names only), `policy` (JSON), `enabled`, `revision`, `created_at`, `updated_at`, `updated_by`                                                                                                                                                   |
| `action_grants`   | `target_id` (FK, cascade), `client_id` (FK `oauth_clients.client_id`), `granted_at`, `granted_by`, `revoked_at`; primary key (`target_id`, `client_id`)                                                                                                                                                                                                                    |
| `action_calls`    | `id`, `at`, `target_id` (no FK; outlives the target), `target_name`, `connector`, `revision`, `tool`, `session_id_hash`, `client_id`, `token_prefix`, `operation`, `classification`, `arguments` (JSON), `arguments_truncated`, `output_bytes`, `output_truncated`, `duration_ms`, `outcome`, `elicitation`, `confirmation_nonce` (unique, nullable), `request_id`, `ip`   |
| `action_sessions` | `id_hash` (SHA-256 of the session id), `target_id`, `client_id`, `token_prefix`, `opened_at`, `last_used_at`, `expires_at`, `closed_at`, `close_reason` (`agent` \| `idle` \| `absolute` \| `revoked` \| `target_changed` \| `operator` \| `shutdown` \| `error`), `calls`; the live context lives in the sidecar, this row is the record and the revocation handle (14.7) |

- **ACT-64** No column holds an injected value, a vault secret, a token, a raw session id or a
  `requestState` (STORE-4 extended). `credential` holds the item id and field names; the vault
  stays the only secret store, so a database leak yields destinations and policies but no way to
  use them.
- **ACT-65** Indexes: `action_targets(name)`, `action_grants(client_id)`, `action_calls(at)`,
  `action_calls(target_id, at)`, `action_calls(confirmation_nonce)`, `action_sessions(id_hash)`,
  `action_sessions(client_id)`.
- **ACT-66** Backup and restore (STORE-7, STORE-8) are unchanged; targets survive a
  `VAULTGATE_SECRET_KEY` rotation (nothing in them is encrypted under it) and only in-flight
  confirmations and open sessions are lost. The maintenance task (STORE-6) closes `action_sessions`
  rows past `expires_at` that the engine did not close itself.

## 13.14 Configuration

| Variable                              | Default | Description                                                                                                                            |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULTGATE_ENABLE_ACTIONS`            | `false` | Master switch. Off: no `actions:*` scope is advertised or effective, no actions tool is listed, the account section is hidden.         |
| `VAULTGATE_ACTIONS_ENABLE_HTTP`       | `false` | Enables the `http` connector (and the `graph` adapter) and `actions:http`.                                                             |
| `VAULTGATE_ACTIONS_ENABLE_SQL`        | `false` | Enables the `sql` connector, `actions:sql.read` and `actions:sql.write`.                                                               |
| `VAULTGATE_ACTIONS_ENABLE_SSH`        | `false` | Enables the `ssh` connector and `actions:ssh`.                                                                                         |
| `VAULTGATE_ACTIONS_ENABLE_WINRM`      | `false` | Enables the `winrm` connector and `actions:winrm`.                                                                                     |
| `VAULTGATE_ACTIONS_ENABLE_BROWSER`    | `false` | Enables the `browser` connector and `actions:browser`. Requires `VAULTGATE_ACTIONS_BROWSER_CDP_URL`.                                   |
| `VAULTGATE_ACTIONS_BROWSER_CDP_URL`   |         | `ws://` or `wss://` URL of the Chromium sidecar's DevTools endpoint (14.7). Must not be a public address.                              |
| `VAULTGATE_ACTIONS_ENABLE_CODE`       | `false` | Enables the `code` connector and `actions:code` (14.8). Requires `VAULTGATE_ACTIONS_CODE_URL`.                                         |
| `VAULTGATE_ACTIONS_CODE_URL`          |         | The code sidecar (ACT-113, ACT-114): an `http://` URL on an address that is not public, or `unix:` and a socket's absolute path.       |
| `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND` | `false` | Allows `ssh`/`winrm` targets to be saved with `any_command: true` (ACT-88). Turning it off later makes such targets refuse every call. |

- **ACT-67** The connector switches are meaningful only with the master switch on; a connector
  switch without the master is a start-up warning. A disabled connector keeps its targets in the
  store, hides them from agents, and answers `connector_disabled` to a call that names one by
  accident (after the grant check, ACT-16).
- **ACT-68** The start-up configuration summary (CFG-3) lists the ten variables; `/readyz` does
  not mention the layer (OPS-4), except that a signed-in operator sees `browser.ready` when the
  connector is enabled (whether the sidecar answered its last probe), and `code.ready` likewise for
  the code sidecar. Section 08's reference table
  gains the rows when M9 lands.

## 13.15 Architecture and dependencies

- **ACT-69** The engine and connectors live in `src/actions/` with this layout, every file under
  300 lines (11.1). Where one concern outgrew a file it is split by cohesion, never by line
  count; the names below are the modules as they exist (M9) or are planned (marked so):

```text
src/actions/
  engine.ts            createActionsEngine: listTargets (ACT-19) and call in the ACT-16 order
  engine-resolve.ts    layer → target → grant → connector → enabled → valid → scope → arguments → policy
  engine-confirm.ts    the confirmation step (ACT-41…48) before the credential is fetched
  engine-run.ts        credential fetch (ACT-50, 54), destination pinning (ACT-55, 56), run under the timeout, scrub and cap
  engine-record.ts     the action_calls row and the MCP-13 audit event of every call (ACT-60, 61)
  engine-listing.ts    actions_list_targets (ACT-19)
  caller.ts            who is calling: client, token prefix, scopes, request, elicitation capability, confirmation input
  errors.ts            the codes and fixed messages of 13.16 (ACT-74)
  targets.ts           the targets service: create, edit, enable, disable, delete, grant, revoke, consent revocation (ACT-10)
  targets-lifecycle.ts create, update, enable, disable, delete with the revision bump and the ACT-7 events
  targets-checks.ts    the save-time checks: ACT-3, ACT-4, ACT-35, ACT-57, ACT-88 and the connector's own
  targets-schemas.ts   the common row schema (ACT-1) and the connector documents through the schema registry
  targets-repo.ts      the repository over action_targets and action_grants
  targets-context.ts   what the target operations share: the summary the pages render, the ACT-7 record
  calls.ts             the action_calls writer: reserve, complete, the single-use nonce (ACT-46)
  policy.ts            pattern matcher (ACT-34), HTTP subject normalisation (ACT-35), common policy fields, PolicyDecision (ACT-39)
  destination.ts       the private-range rule and the pinned address (ACT-55, 56)
  confirm.ts           requestState mint/verify (ACT-44…46), ElicitResult handling, the ACT-42 document
  scrub.ts             variant generation and replacement (ACT-51, 52)
  secrets.ts           the secrets one call holds, its run's own included (ACT-50, 82)
  run-support.ts       what the engine lends a run: a second host, a captured secret, the ACT-83 rotation
  limits.ts            per-target and per-client buckets and in-flight counters (ACT-59)
  sessions.ts          closing action_sessions on the revocation paths; the browser session registry is M15
  audit.ts             the actions.* audit events (ACT-7)
  pages/               the account-page section, the target and create pages and their routes (ACT-5, 6), composed by src/http/
  connectors/
    connector.ts       the connector interface (14.1)
    registry.ts        schemas of every connector; runtimes loaded for enabled connectors only (ACT-73)
    http/              the runtime (M9): schemas (14.2), the tool (ACT-20, 21), authorize (pure), request, response, run, index
    graph/             the 14.3 adapter: document, token exchange, cache, write-back
    sql/               tokeniser and classifier; mssql/ and postgres/ drivers
    ssh/               the runtime (M12): schemas (14.5), the host-key parser and matcher, the tool, authorize (pure), the ssh2 driver shape, client, channel, run
    winrm/             the runtime (M13): schemas (14.6), the tool, authorize (pure), the SOAP envelopes, the strict response reader, client (shell lifecycle), run, index
    browser/           CDP client, login sequence, origin interception, snapshot and masking (planned)
    code/              the runtime (M16): schemas (14.8), the GitHub fetch, the sidecar client, snapshots and builds, the three tools
```

- **ACT-70** Dependency-cruiser gains a layer: `src/actions/` MAY import `result`, `config`,
  `logger`, `net`, `crypto`, `scopes`, `vault`, `storage` and `audit`; it MUST NOT import
  `identity/`, `oauth/`, `mcp/`, `bitwarden/` or `http/` except type-only imports from
  `identity/` (the guard and session types its pages need, injected by composition), the
  escaping template primitives of `identity/pages/template.ts` (the one HTML path of ID-19,
  which know nothing of identity and which the OAuth pages share the same way) and type-only
  imports from `mcp/` (the `Tool` shape). `src/mcp/tools/actions.ts` imports the engine's public interface;
  `src/http/` composes the pages; the revocation paths of `oauth/` reach sessions through a
  callback the composition layer wires, never by import. `identity/`, `oauth/` and `bitwarden/`
  never import `actions/`.
- **ACT-71** ARCH-2 stands: no connector imports `child_process`; `ssh_run` and `winrm_run`
  execute on the remote host only, and the browser runs in the sidecar, never in the vaultgate
  process or image. The lint rule is unchanged and the module-graph rule adds `actions/` to the
  list it applies to.
- **ACT-72** Runtime dependencies are added one per connector milestone with the QG-9
  justification: `pg` and `mssql` (M11), `ssh2` (M12), nothing for WinRM (M13 evaluated the npm
  clients and wrote the client by hand), and `playwright-core` (M15; the driver only, it downloads
  no browser). The `http` connector and the `graph` adapter add no dependency. Native addons
  remain unacceptable; a package whose install compiles or downloads anything is rejected.
- **ACT-73** The engine is constructed only when `VAULTGATE_ENABLE_ACTIONS=true`; otherwise
  `src/main.ts` passes no engine, the MCP tool registry registers no actions tool, the scope
  registry advertises no actions scope, the console has no Connections section, and the connectors'
  modules are never imported (dynamic import at engine construction, so knip and the module-graph
  rules still see them).

## 13.16 Error codes

| Code                         | Meaning                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions_disabled`           | `VAULTGATE_ENABLE_ACTIONS` is off (only reachable by a token issued while it was on).                                                                                                                                                                                                               |
| `connector_disabled`         | The target's connector is switched off (ACT-67).                                                                                                                                                                                                                                                    |
| `unknown_target`             | No enabled, granted target of that name for this client.                                                                                                                                                                                                                                            |
| `target_disabled`            | The target exists and is granted but is disabled.                                                                                                                                                                                                                                                   |
| `target_invalid`             | The stored target fails schema validation (ACT-1); the operator page shows why.                                                                                                                                                                                                                     |
| `not_granted`                | The target exists but this client has no grant.                                                                                                                                                                                                                                                     |
| `insufficient_scope`         | The token does not hold the scope the tool needs (ACT-16). The MCP layer answers this with the OAUTH-33 challenge before the engine is reached.                                                                                                                                                     |
| `invalid_arguments`          | Argument shape or parameter binding problem (ACT-20, 23, 27, 29…33).                                                                                                                                                                                                                                |
| `policy_denied`              | The policy refused the operation; `detail.reason` is one of ACT-39's reasons.                                                                                                                                                                                                                       |
| `rate_limited`               | ACT-59; `detail.retry_after_s`.                                                                                                                                                                                                                                                                     |
| `confirmation_unavailable`   | The target requires confirmation and the client cannot elicit (ACT-48).                                                                                                                                                                                                                             |
| `confirmation_declined`      | The human declined or did not tick the box (ACT-47).                                                                                                                                                                                                                                                |
| `confirmation_cancelled`     | The human dismissed the prompt (ACT-47).                                                                                                                                                                                                                                                            |
| `confirmation_expired`       | The retried `requestState` is older than 2 minutes (ACT-45).                                                                                                                                                                                                                                        |
| `confirmation_invalid`       | The `requestState` does not verify or does not match the retried call (ACT-45).                                                                                                                                                                                                                     |
| `confirmation_reused`        | The nonce was already consumed (ACT-46).                                                                                                                                                                                                                                                            |
| `credential_unavailable`     | The vault is locked, or the item or field is missing (one fixed message, ACT-54).                                                                                                                                                                                                                   |
| `credential_rotation_failed` | The `graph` refresh-token write-back failed (ACT-83).                                                                                                                                                                                                                                               |
| `destination_refused`        | The destination resolved to an address the private-range rule refuses (ACT-56).                                                                                                                                                                                                                     |
| `host_key_mismatch`          | SSH host key differs from the pinned one (ACT-87).                                                                                                                                                                                                                                                  |
| `tls_error`                  | Certificate verification failed (ACT-57).                                                                                                                                                                                                                                                           |
| `connection_failed`          | The destination refused or reset the connection, or DNS failed.                                                                                                                                                                                                                                     |
| `authentication_failed`      | The destination rejected the injected credential.                                                                                                                                                                                                                                                   |
| `timeout`                    | The policy timeout elapsed; work was cancelled (ACT-25, ACT-90).                                                                                                                                                                                                                                    |
| `upstream_error`             | The destination reported an error after authentication (SQL error, WinRM fault); `detail.message` carries its text, scrubbed and capped at 1 KiB.                                                                                                                                                   |
| `connector_fault`            | The call failed inside vaultgate, not at the destination, which may never have been contacted; `detail.reason` is `internal` (a JavaScript fault, `detail.message`), `driver_export` (a driver package whose export shape changed) or a connector's own, such as `sql`'s `exact_numeric_precision`. |
| `browser_unavailable`        | The sidecar did not answer on `VAULTGATE_ACTIONS_BROWSER_CDP_URL` (ACT-92).                                                                                                                                                                                                                         |
| `login_failed`               | `browser_open` could not complete the sign-in (ACT-29, ACT-94); `detail.stage` is `form`, `submit`, `totp` or `landing`.                                                                                                                                                                            |
| `unknown_session`            | No open session of that id for this client (ACT-16).                                                                                                                                                                                                                                                |
| `session_expired`            | The session passed its idle or absolute TTL, or was closed by a revocation path (ACT-96).                                                                                                                                                                                                           |
| `session_limit`              | The client already holds `max_sessions` sessions on this target (ACT-96).                                                                                                                                                                                                                           |
| `index_unavailable`          | The code sidecar did not answer on `VAULTGATE_ACTIONS_CODE_URL` (ACT-113).                                                                                                                                                                                                                          |
| `index_not_ready`            | The `code` index is not built yet; `detail.state` is `building` or `failed`, with `detail.repo` and, when failed, `detail.reason` (ACT-112).                                                                                                                                                        |
| `path_not_found`             | The path is not a regular file in the snapshot, including an excluded or skipped file (ACT-111).                                                                                                                                                                                                    |
| `ref_not_found`              | GitHub has no branch, tag, commit or pull request of that name in the repository (ACT-104).                                                                                                                                                                                                         |
| `chunk_not_found`            | `code_find_related` names a line no indexed chunk holds (ACT-111).                                                                                                                                                                                                                                  |
| `not_text`                   | `code_read` of a file that is not text (ACT-111).                                                                                                                                                                                                                                                   |
| `element_not_found`          | The `ref` is not in the current page (ACT-32).                                                                                                                                                                                                                                                      |

- **ACT-74** Every code has one fixed `message`; `detail` is the only variable part, is scrubbed
  (ACT-51), and never contains a destination address, an origin list, a vault item id or a
  policy pattern. Codes are stable API like tool names (12.5).

## 13.17 Non-goals

- No file transfer or file access tool (no SFTP, no `scp`, no download through the browser, no
  reading a path on the remote host other than through a command the allowlist admits). The one
  exception is `code_read` (ADR 0008), which reads only from the snapshot of a repository the
  operator configured, resolved inside that snapshot (ACT-111).
- No process execution anywhere except on the remote host of an `ssh` or `winrm` target and
  inside the browser and code sidecars; nothing runs on the vaultgate host (ARCH-2).
- No multi-hop: a target is one destination; a command that reaches a further host does so
  under that host's own controls, and the policy of the first target is the only one vaultgate
  applies. Jump hosts, tunnels and port forwarding are not offered.
- No interactive sessions except the bounded browser session of 14.7: one operation per call,
  no PTY, no persistent shell, no cursor or transaction held between calls.
- No export of browser state, ever: no tool returns cookies, local or session storage, the
  DevTools endpoint or a profile; the operator page cannot either (ACT-99).
- No agent-created targets, no agent-editable policy, no "temporary" grants from the agent side.
- No credential types beyond what `get_secret` can name (a vault field), and no storing of a
  credential in `action_targets`.
- No connectors beyond the seven (SMTP, S3, Kubernetes and the like are declined until each has
  a policy model as tight as these; a generic "TCP" connector is declined outright). `code`
  joined the original six through ADR 0008 as a read-only connector with an operator-fixed
  destination.

## 13.18 Verification

- **ACT-75** Each connector ships with contract tests against a fake transport that cover every
  policy reason, every error code it can raise, the scrubber over a destination that echoes its
  request, the caps and the timeout, plus the ACT-53 canary suite; and a live test, run manually
  and recorded in the milestone's pull request, against the maintainer's own systems (an HTTPS
  API and a Microsoft 365 tenant for `http`/`graph`, a SQL Server and a PostgreSQL database for
  `sql`, a Linux host for `ssh`, a Windows host for `winrm`, two of the maintainer's own web
  applications for `browser`).
- **ACT-76** The elicitation flow is tested in-process with the SDK client declaring, in turn,
  form-mode elicitation on `2026-07-28`, elicitation at `initialize` on an older negotiated
  version, and no elicitation, asserting the behaviours of ACT-42 and ACT-48 and every outcome of
  ACT-47, with replay, expiry, edited-target and altered-argument retries refused (ACT-45, 46).
  The older-version case asserts the refusal ACT-48 records: the client is answered
  `confirmation_unavailable`, is never shown a prompt though it offered to render one, and the
  call leaves its `action_calls` row; a read on the same target and the same wire still runs, so
  the limit is the confirmation and nothing else.
- **ACT-77** The classifier (13.7.2) has a corpus of statements per engine, including comment and
  string tricks (`SELECT 1; DROP …`, `SELECT '…; DROP' …`, `/* */` splits, dollar quoting,
  `SELECT … INTO`, `WITH … AS (DELETE …)`, `EXEC` inside a string), and every corpus entry is a
  named test.
