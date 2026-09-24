# 13 Actions: typed, policy-gated use of vault credentials

> **Status: M9 to M14 landed.** This section specifies the actions
> layer decided in [ADR 0007](../adr/0007-typed-actions-with-operator-policy.md) and sequenced as
> milestones M9 to M15 in [`PLAN.md`](../PLAN.md). Everything it specifies has landed except what
> "not yet" names below: M9 brought the engine with the resolution order of ACT-16, the tool
> surface of 13.6, the account pages of 13.3.2, the `action_calls` trail and the `http` connector
> (14.2) with `http_request`; M10 the `graph` credential adapter (14.3; ACT-81…83); M11 the `sql`
> connector (14.4) with `sql_query` and `sql_execute` (13.6.4) and the classification of 13.7.2
> (ACT-36…38); M12 the `ssh` connector (14.5) with `ssh_run` (13.6.5; ACT-27, ACT-28, ACT-87,
> ACT-88); and M13 the `winrm` connector (14.6) with `winrm_run` (13.6.5; ACT-89, ACT-90). M14
> brought the per-target call history and ACT-63's "unexpected write" view, grant management from
> the connected-clients list, the per-field validation messages of ACT-6, the `confirm_writes`
> default of ACT-49 and the proof behind ACT-48's rewritten second half: the in-band fallback for
> the 2025 wire is unimplementable under MCP-1, so a client on that wire is refused a confirmed
> target with `confirmation_unavailable` and the clause now says why. Not yet: the `browser`
> connector of M15 (no tool is listed until its runtime lands). The per-connector
> contracts are in [14 Action connectors](14-actions-connectors.md); the `ACT-n` sequence
> continues there.

## 13.1 Purpose

The vault tools let an agent _read_ a secret (`get_secret`, audited, one field per
call). Using that secret then happens wherever the agent runs, outside every control
vaultgate has: the value sits in the model's context, in the client's logs, in a
command line. The actions layer lets an agent _use_ a credential without ever
receiving it. The operator defines a **target** (a destination, the vault item that
authenticates to it, a policy of what is allowed there, and which clients may use
it); the agent names the target and describes an operation; vaultgate fetches the
credential from the vault, connects, runs the operation inside the policy, scrubs the
result and returns it.

Design rules, in priority order:

1. **Targets, not tools.** Agents never pass a host, a URL base, a database name or a
   credential. Every destination and credential is operator data, set on the account
   page behind re-authentication (ID-15). An agent argument can change _what_ runs at
   a target, never _where_ or _as whom_.
2. **Secrets never come back.** No tool in this section returns an injected value, and
   every result, error and audit row is scrubbed of every injected value and its
   encoded variants before it leaves the engine (13.9).
3. **Read-only by default, writes are opt-in three times.** A write needs its own scope
   at consent, a target policy that allows the operation, and (when the operator asks
   for it) a per-call human confirmation through MCP elicitation (13.8).
4. **Off unless enabled.** The whole layer is absent (no scopes, no tools, no pages)
   unless `VAULTGATE_ENABLE_ACTIONS=true`, and each connector has its own switch (13.14).
5. **Still no arbitrary execution.** `ssh_run` and `winrm_run` run one command against
   one pre-configured host under an operator-written allowlist; a `browser` session is
   confined to the origins the operator listed. A target that accepts any command exists
   only when the operator sets an explicit per-target flag _and_ the deployment allows
   such targets. ADR 0004 remains true for the vault tools.

## 13.2 Terms

| Term           | Meaning                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Target         | An operator-defined destination plus credential mapping, policy and grants, identified to agents by `name`.                                     |
| Connector      | The protocol implementation behind a target: `http`, `sql`, `ssh`, `winrm` or `browser` (section 14).                                           |
| Operation      | What one tool call asks a target to do: an HTTP request, a statement, a command, a browser action.                                              |
| Injected value | A secret fetched from the vault for one call (a password, a key, a TOTP code, a token vaultgate obtained with one), never seen by the agent.    |
| Grant          | The operator's decision that one OAuth client may use one target.                                                                               |
| Confirmation   | A per-call human approval obtained through MCP elicitation for write, shell or browser-act operations on a target that requires it.             |
| Session        | A `browser` target's logged-in Chromium context, opened by one client and bounded by a TTL (14.7); the only state the layer holds across calls. |
| Engine         | `src/actions/`: target lookup, grant and scope checks, policy, confirmation, secret fetch, scrubbing, caps, sessions, audit.                    |

## 13.3 Targets

### 13.3.1 Fields

- **ACT-1** A target is one row of `action_targets` (13.13) with the fields below. `destination`,
  `credential` and `policy` are JSON documents whose shape depends on `connector`; every
  document is validated by a zod schema on write and again on read, and a row that fails
  validation is reported on the account page and refuses every call with `target_invalid`.

| Field                                    | Type                                             | Rules                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | UUID                                             | Internal; never shown to agents.                                                                                                                            |
| `name`                                   | string                                           | `^[a-z0-9][a-z0-9-]{0,62}$`, unique per deployment, stable API for agents. Renaming is a new target.                                                        |
| `description`                            | string ≤ 200 chars                               | Operator prose shown to agents by `actions_list_targets`; written for an LLM audience (what the destination is, what to use it for).                        |
| `connector`                              | `http` \| `sql` \| `ssh` \| `winrm` \| `browser` | Fixed at creation.                                                                                                                                          |
| `destination`                            | JSON                                             | Connector-specific (section 14). Always a host, URL or origin the operator typed; never derived from an agent argument.                                     |
| `internal`                               | boolean, default `false`                         | When `true` the destination may resolve to a private-range address (13.10). Loopback and link-local are refused whatever this says.                         |
| `credential`                             | JSON `{ item_id, mapping }`                      | `item_id` is a vault item id; `mapping` names which secret fields feed which injection points (section 14). The row holds field _names_, never values.      |
| `policy`                                 | JSON                                             | Connector-specific allowlists and limits (13.7) plus the common fields `timeout_ms`, `max_output_bytes`, `rate_limit_per_minute`, `confirm_writes`.         |
| `enabled`                                | boolean, default `true`                          | A disabled target is listed to no agent and refuses every call with `target_disabled`.                                                                      |
| `revision`                               | integer                                          | Incremented on every change; recorded on every call's audit row, used as the cache key for adapter tokens (14.3) and invalidates open confirmations (13.8). |
| `created_at`, `updated_at`, `updated_by` | ms epoch, ms epoch, operator id                  | Conventions of section 07.                                                                                                                                  |

- **ACT-2** A target's `destination` and `credential.item_id` MUST refer to things the operator
  typed or chose on the account page. No tool creates, edits or deletes a target; there is no
  API for targets other than the operator pages.
- **ACT-3** Saving a target validates the destination the same way a call does (13.10): each
  host is resolved and checked against the private-range rule for the target's `internal` flag,
  and a destination that fails is rejected with the reason. Saving does not connect and does not
  touch the vault beyond ACT-4.
- **ACT-4** The `credential.item_id` MUST exist in the vault at save time (checked through
  `VaultClient.getItem`, metadata only) and each mapped field MUST be one the item reports as
  present. A mapping to a field the item lacks is rejected at save; a field that disappears later
  fails the call with `credential_unavailable`.

### 13.3.2 Operator pages

- **ACT-5** The account page gains an **Actions** section, present only when
  `VAULTGATE_ENABLE_ACTIONS=true`. It lists targets (name, connector, destination summary,
  enabled, grants, last call, open sessions) and offers create, edit, disable, enable, delete,
  grant management and "close sessions". Every write is a `POST /account/actions/*` route behind
  the ID-18 checks and re-authentication (ID-15); the re-authentication window is the same
  5 minutes.
- **ACT-6** Pages follow ID-19: no JavaScript, one stylesheet, escaped templates. Policy
  allowlists are edited as one pattern per line. Connector-specific fields are validated
  server-side with the same zod schemas as ACT-1, and a rejected form re-renders with every
  problem listed.
- **ACT-7** Every target change records an audit event `actions.target_created`,
  `actions.target_updated`, `actions.target_deleted`, `actions.target_enabled`,
  `actions.target_disabled`, `actions.grant_added`, `actions.grant_removed` or
  `actions.sessions_closed` with the target name, connector, the operator id and, for updates,
  the list of changed field names (never values; the `credential` document is reported as
  `credential` only). `actions.credential_rotated` (ACT-83) is the one event here with no
  operator: the target, the item and the field, never the value.
- **ACT-8** Deleting a target deletes its grants, closes its sessions and keeps its
  `action_calls` rows (the audit trail outlives the target; rows carry the name and connector
  redundantly for that reason).

## 13.4 Grants

- **ACT-9** A target is usable by an OAuth client only while a row in `action_grants` joins
  them and neither the grant nor the client's consent is revoked. Grants are per client (the
  `oauth_clients.client_id`, the identifier every consent and token row carries), not per token, and are managed from the target's page by choosing among
  the clients that currently hold a consent. A client with no grant sees the target nowhere and
  a call to it answers `not_granted`.
- **ACT-10** Revoking a client's consent (OAUTH-30) MUST also revoke that client's grants and
  close its sessions, so a reconnected client starts with none.
- **ACT-11** A grant does not widen a token: the token still needs the connector's scope (13.5)
  and the deployment still needs the connector enabled (13.14).

## 13.5 Scopes and consent

| Scope               | Grants                                                                 | Consent text                                                                                                |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `actions:http`      | `http_request` against granted `http` targets                          | Send HTTP requests to web APIs the operator has configured, signed with credentials from the vault.         |
| `actions:sql.read`  | `sql_query` against granted `sql` targets                              | Run read-only queries against databases the operator has configured.                                        |
| `actions:sql.write` | `sql_execute` against granted `sql` targets whose policy allows writes | Change data in databases the operator has configured.                                                       |
| `actions:ssh`       | `ssh_run` against granted `ssh` targets                                | Run commands on servers the operator has configured, over SSH.                                              |
| `actions:winrm`     | `winrm_run` against granted `winrm` targets                            | Run commands on Windows hosts the operator has configured, over WinRM.                                      |
| `actions:browser`   | The `browser_*` tools against granted `browser` targets                | Sign in to websites the operator has configured and act there as you, within the pages the operator allows. |

- **ACT-12** The six scopes join the registry in `src/scopes/registry.ts` (one registry). None
  implies another, and none implies or is implied by a `vault:*` scope. `actions_list_targets`
  needs at least one `actions:*` scope and lists only the targets that scope set can call. Its
  OAUTH-33 challenge names every enabled `actions:*` scope as one any-of set
  (`scope="actions:http actions:sql.read …"`, `error_description="actions_list_targets requires
any of …"`), so a client learns in one challenge every scope that would satisfy the call; a
  connector tool's challenge names its one scope.
- **ACT-13** Every `actions:*` scope is `risky: true` on the consent page (OAUTH-36) and the page
  adds one plain-language line above the group: "These let the agent act on other systems with
  your credentials. It never sees the credentials, but it can do what the targets allow."
  `actions:browser` adds: "A signed-in browser can do anything you can do on that site."
- **ACT-14** The scopes are absent from `scopes_supported` (OAUTH-1, OAUTH-2) and from
  `enabledScopes` unless `VAULTGATE_ENABLE_ACTIONS=true`; a connector's scope is absent unless
  that connector is also enabled. As with `vault:write`, a token that holds a scope the deployment
  has since disabled simply no longer has it in effect (`effectiveScopes`), and `tools/list`
  omits the tools (MCP-7).

## 13.6 Tools

### 13.6.1 Common rules

- **ACT-15** Tools follow section 06: zod `inputSchema` and `outputSchema`, both strict, every
  result also as text (`content`), failures as `{ error, message, detail? }` with `isError: true`.
  Tool names are stable API. The registration lives in `src/mcp/tools/actions.ts` and dispatches
  to the engine (13.15): a connector declares each of its tools (name, scope, description,
  annotations, the operation arguments and the result schema) on its `Connector`, and the
  registration puts `target` in front of the arguments and advertises only the tools of the
  connectors whose runtime is loaded.
- **ACT-16** Every tool takes `target` (the name, ACT-1) or `session_id` (browser tools, which
  resolve the session's target) as its first argument and resolves it in this order, stopping at
  the first failure: layer enabled → target exists → client granted → connector enabled →
  target enabled → stored target valid (ACT-1) → token holds the tool's scope → arguments valid
  → policy allows the operation (13.7) → rate limits (13.11) → confirmation if required (13.8)
  → credential fetched (13.9) → destination pinned (13.10) → run. Each failure has its own error
  code (13.16) and its own audit outcome, and the grant check comes before every check that
  would describe the target, so an ungranted client learns nothing about a target beyond
  `not_granted` (ACT-67 places `connector_disabled` after the grant for the same reason).
- **ACT-17** Tool descriptions state the arguments' meaning, what the result contains, that the
  result never contains credentials, that `target` must come from `actions_list_targets`, and,
  for the write, shell and browser tools, that the operator may require a confirmation the agent
  cannot supply.
- **ACT-18** Annotations use the MCP `ToolAnnotations` fields exactly: `title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`. The `ToolAnnotations` type in
  `src/mcp/tools/definition.ts` currently fixes `openWorldHint: false`; the actions tools widen it
  to `boolean`. Annotations are hints the client MAY use to decide whether to ask its user; the
  MCP specification tells clients to treat them as untrusted, so the server-side controls of
  13.7 and 13.8 never depend on them.

| Tool                   | Scope               | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| ---------------------- | ------------------- | -------------- | ----------------- | ---------------- | --------------- |
| `actions_list_targets` | any `actions:*`     | `true`         | `false`           | `true`           | `false`         |
| `http_request`         | `actions:http`      | `false`        | `true`            | `false`          | `true`          |
| `sql_query`            | `actions:sql.read`  | `true`         | `false`           | `true`           | `true`          |
| `sql_execute`          | `actions:sql.write` | `false`        | `true`            | `false`          | `true`          |
| `ssh_run`              | `actions:ssh`       | `false`        | `true`            | `false`          | `true`          |
| `winrm_run`            | `actions:winrm`     | `false`        | `true`            | `false`          | `true`          |
| `browser_*` (all six)  | `actions:browser`   | `false`        | `true`            | `false`          | `true`          |

`http_request` carries write annotations although a `GET` changes nothing: annotations are per
tool, the method is an argument, and a client that prompts before every `http_request` is the
right default. Every `browser_*` tool carries them because a signed-in session is a logged-in
user whatever the individual tool does. Read-only HTTP targets that want silent calls are a
post-M15 candidate (`http_get` with `readOnlyHint: true`), not a reason to weaken the hint.

### 13.6.2 `actions_list_targets`

- **ACT-19** Input: none. Output: `targets`, an array of `{ name, description, connector,
operations, confirm_writes, engine?, unrestricted? }` where `operations` is the subset of `read`,
  `write`, `shell`, `act` the target's policy allows and the token's scopes can reach,
  `confirm_writes` says whether non-read calls will ask for confirmation, `engine` (`mssql` \|
  `postgres`) appears for `sql` targets and `unrestricted: true` marks an any-command target (ACT-88).
  The output schema has no place for a destination, an origin, a credential field name or a policy
  pattern. Only granted, enabled targets of enabled connectors appear.

### 13.6.3 `http_request`

- **ACT-20** Input: `target`; `method` (one of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`,
  `OPTIONS`); `path` (string starting with `/`, ≤ 2 KiB, may carry a query string; no scheme, no
  host, no `..` or empty segment, no fragment, no whitespace, backslash or control character);
  `headers`
  (object of string → string, ≤ 32 entries, names matched case-insensitively against the policy
  allowlist); `body` (string ≤ `max_body_bytes`, or a JSON object or array serialised with
  `Content-Type: application/json` when the agent sets no content type). `path` is appended to
  the destination's `base_url` (its prefix, then the ACT-35 subject); the resolved URL
  MUST stay under `base_url` after normalisation (the built URL is checked, so `//host`
  cannot move the host) or the call fails `policy_denied` (`reason: path`). A percent-encoded
  separator — `%2F` or `%5C` — in the path portion is refused as an invalid argument: ACT-35
  decodes the unreserved characters only, so neither dot-segment removal nor a `*` treats such an
  escape as a boundary, while a destination that decodes it before routing does. The query string
  may carry either.
- **ACT-21** Output: `status` (integer), `headers` (only the names in the policy's
  `response_headers` list, default `content-type`, `content-length`, `location`, `retry-after`),
  `body` (text when the media type is textual — `text/*`, JSON, XML, JavaScript, form-encoded
  or absent — and the bytes are valid UTF-8; otherwise base64 with `body_encoding: "base64"`,
  cut to fit the cap), `bytes` (received: the whole body unless
  `truncated`), `truncated`, `duration_ms`. The connector never encodes the body itself: it hands
  the bytes to the engine, which scrubs them and then encodes (ACT-51). A non-2xx status is a
  normal result, not an error:
  a `401` is never `authentication_failed`; connection and TLS failures are errors whose
  `detail.reason` names the error code (ACT-74).
- **ACT-22** The agent cannot set `Authorization`, `Cookie`, `Host`, `Content-Length`,
  `User-Agent`, `Proxy-*`, `Transfer-Encoding` or any header the credential mapping injects
  (`authorize` gets the credential document, 14.1); such a header fails
  `policy_denied` (`reason: header`) whatever `allowed_request_headers` says. Redirects are not
  followed unless `policy.follow_redirects` is `true`, and then at most 2 hops, each required to
  stay under `base_url`: the same origin, so a hop connects to the address the call already
  validated (13.10) and the name is never resolved again (ACT-55); the credential is re-applied
  only on such hops. A redirect not followed (policy off, leaving `base_url`, a third hop) is
  the result, `location` included. 301, 302 and 303 turn a
  `POST` (303: all but `HEAD`) into a body-less `GET`; 307 and 308 keep method and body.

### 13.6.4 `sql_query` and `sql_execute`

- **ACT-23** Input for both: `target`; `statement` (string ≤ 64 KiB; no NUL byte and no other C0
  control character — tab, carriage return and line feed are the only ones accepted, as ACT-27
  requires of a command, because the tokeniser of 13.7.2 is a control in depth and every character
  it must agree with the server's lexer about that no statement legitimately contains is a
  divergence); `params` (array ≤ 100 of
  string, number, boolean or `null`, bound positionally to the engine's native placeholders,
  `$1…$n` for PostgreSQL and `@p1…@pn` for SQL Server). There is no string interpolation path:
  a placeholder without a matching parameter or a parameter without a placeholder fails
  `invalid_arguments`.
- **ACT-24** `sql_query` output: `columns` (array of `{ name, type }`, `type` the engine's type
  name), `rows` (array of arrays of JSON scalars; dates as ISO 8601 strings, binary as base64,
  decimals as strings), `row_count`, `truncated` (rows beyond `max_rows` were dropped),
  `duration_ms`. A decimal string carries the scale the column declares, so a `decimal(10,2)`
  holding 3.50 is `"3.50"`. On SQL Server that is as exact as the driver allows: Tedious parses
  `decimal`, `numeric`, `money` and `smallmoney` into a JavaScript double in its own value parser,
  before `mssql`'s `valueHandler` registry or anything else vaultgate can reach, so a value whose
  unscaled integer exceeds `Number.MAX_SAFE_INTEGER` has already lost digits. Such a value is
  refused — `connector_fault` with `detail.reason: "exact_numeric_precision"` and the column name
  — rather than rendered as a rounded string, because a silently wrong money column is the exact
  failure this requirement exists to prevent; the guide tells the agent to cast the column to
  `varchar` in the statement. PostgreSQL's driver hands decimals over as strings and loses
  nothing.
- **ACT-25** `sql_execute` output: `rows_affected`, `columns` and `rows` for the rows the
  statement returned (`RETURNING`, `OUTPUT`) — both empty when it returned none, so the shape
  does not change with the statement — `truncated` and `duration_ms`. The statement runs in its
  own transaction that commits on success and rolls back on any error or on the timeout; on the
  timeout the connection is dropped, which rolls it back too. `sql_query` accepts only the
  `read` class and `sql_execute` only `dml` and `ddl`, so neither tool can be made to do the
  other's work whatever scopes the token holds.
- **ACT-26** Statement classification (13.7.2) runs before any connection is opened, on both
  tools, and the result (`read`, `dml`, `ddl`, `other`) is audited, on a refused call as well as
  on one that ran.

### 13.6.5 `ssh_run` and `winrm_run`

- **ACT-27** Input for both: `target`; `command` (string ≤ 16 KiB; no NUL byte and no other C0
  control character — tab, carriage return and line feed are the only ones accepted, because XML
  1.0 cannot carry the rest even as a character reference and `winrm_run` sends the command in a
  SOAP envelope; a newline, a carriage return and the shell metacharacters of ACT-35 are allowed
  only on a target with `any_command: true`); `stdin` (optional string
  ≤ 64 KiB, written to the process's standard input and then closed). Output for both:
  `exit_code` (integer, or `null` when the channel closed without one), `stdout`, `stderr`,
  `truncated`, `duration_ms`. `stdout` and `stderr` are captured separately and each is capped at
  `max_output_bytes`.
- **ACT-28** `ssh_run` opens one exec channel per call, requests no PTY, no agent forwarding, no
  X11, no environment variables and no port forwarding, and closes the connection when the call
  ends. `winrm_run` creates one WS-Management shell per call (`cmd` or `powershell` per the
  target's `shell`; for `powershell` the command is sent as an encoded command, and
  `WINRS_SKIP_CMD_SHELL` is set so no `cmd.exe` re-parses it), writes `stdin` as one `Send` and
  closes it, collects output, signals termination on timeout and deletes the shell.

### 13.6.6 `browser_*`

The six browser tools are a subset of the Playwright MCP tool vocabulary, so an agent that
already knows `browser_snapshot` and element `ref`s needs no new habits. Every call after
`browser_open` names a `session_id`; the engine resolves the session to its target and client
before anything else (ACT-16) and a session opened by another client answers `unknown_session`.

- **ACT-29** `browser_open(target)` → `{ session_id, url, title, expires_at }`. vaultgate opens a
  fresh browser context in the sidecar (14.7), navigates to the target's `login_url`, fills the
  username, password and (when the item has one) TOTP code from the vault item, submits, waits
  for navigation to settle and returns. The agent does not drive the login: no tool exposes the
  login form's password field, and the credential is typed by the engine, never by `browser_type`.
  A login that does not leave the login page, or that lands outside the allowed origins, fails
  `login_failed` and the context is closed.
- **ACT-30** `browser_navigate(session_id, url)`: `url` MUST be `https://` (or `http://` on an
  `internal` target) with an origin in the target's allowed origins, else `policy_denied`
  (`reason: origin`) without navigating. Returns `{ url, title }` after load.
- **ACT-31** `browser_snapshot(session_id)` → `{ url, title, snapshot }`: the page's accessibility
  tree as text with element references (`ref`s) the other tools accept, capped at
  `max_output_bytes`, scrubbed (13.9). Password inputs are rendered as `[password field]` with no
  value, and any node whose text or value contains an injected value is rendered as
  `[redacted:<field>]`.
- **ACT-32** `browser_click(session_id, ref)` and `browser_type(session_id, ref, text, submit?)`
  act on an element from the last snapshot; both are **act** operations (13.7.3). `browser_type`
  refuses a password input (`policy_denied`, `reason: element`) so an agent can never type into
  a credential field, and refuses `text` that contains an injected value. Both return the
  post-action `{ url, title }`; the agent takes a new snapshot to see the result.
- **ACT-33** `browser_screenshot(session_id)` returns an MCP `image` content item (PNG, viewport
  only, ≤ `max_output_bytes`) plus `{ url, title }`, allowed only when `policy.screenshots` is
  `true`. Before capture the engine masks every password input and every DOM text node or input
  value containing an injected value (14.7). `browser_close(session_id)` closes the context and
  returns `{ closed: true }`; closing an unknown or expired session is `unknown_session`.

## 13.7 Policy semantics

### 13.7.1 Patterns

- **ACT-34** Allowlist patterns are glob-like strings, not regular expressions, so an operator
  cannot write a super-linear pattern and the matcher cannot be exploited (ReDoS): `*` matches any
  run of characters except `/` (paths) or a line terminator, carriage return as well as line feed
  (commands, and the statements of ACT-38, which may contain either); `**` matches any run including
  `/` (paths only); every other character is literal; matching is anchored at both ends and
  case-sensitive except for HTTP header names and methods. A pattern list matches when any
  pattern matches the whole subject.
- **ACT-35** HTTP subjects are the request path plus query, relative to `base_url`, after
  normalisation (percent-decoding of unreserved characters, dot-segment removal). Command subjects
  are the exact `command` string, and on a target that is not an `any_command` one a command MUST
  NOT contain a shell metacharacter — `;`, `&`, `|`, a backtick, `$`, `<`, `>`, `(` or `)` — any
  more than it may contain a line break: it fails `policy_denied` (`reason:
command_metacharacter`) before the patterns are consulted. A pattern cannot restrain one, because
  `*` matches a run of characters and every metacharacter is a character; without this rule a
  single wildcard made `journalctl -u nginx --since *` accept
  `journalctl -u nginx --since $(curl … | sh)`, so every allowlist holding a wildcard was an
  unrestricted target without the deployment switch of ACT-88, the standing operator warning,
  `unrestricted: true` in `actions_list_targets` or the full command in `classification`. A
  pattern that itself holds a metacharacter could therefore never match and is refused at save. Browser origins are compared exactly (scheme, host, port) and
  are never patterns. A pattern that would allow everything (`*`, `**`) is refused at save for
  commands unless `any_command` is what the operator means; for paths `/**` is allowed and is the
  documented way to say "the whole API". Each `allowed_paths` pattern is itself checked at save:
  it must start with `/`, must not climb above `base_url`, and must be written in the normalised
  form it will be matched against.

### 13.7.2 SQL classification

- **ACT-36** A statement is tokenised (strings, quoted identifiers, `--` and `/* */` comments,
  dollar-quoted strings on PostgreSQL) and MUST be exactly one statement. A `--` comment ends at
  the first line terminator, **carriage return as well as line feed**: PostgreSQL's lexer defines
  `non_newline` as `[^\n\r]` and T-SQL ends a line comment at a bare CR too, so a tokeniser that
  looked for `\n` alone would swallow a statement the server would go on to run. A `;` outside a
  string or
  comment that is followed by anything other than whitespace, a trailing comment included, fails
  `policy_denied` (`reason: statement_count`). Comments are stripped before classification.
  Tokenisation is per engine, which is why `authorize` receives the destination (14.1).
- **ACT-37** `read`: the first keyword is `SELECT`, `WITH` or `EXPLAIN`, and no keyword of the
  set `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `EXEC`, `EXECUTE`, `CALL`, `CREATE`, `ALTER`,
  `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`, `COPY`, `LOCK`, `SET`, `USE`, `BACKUP`,
  `RESTORE`, `SHUTDOWN`, `RECONFIGURE`, `WAITFOR`, `OPENROWSET`, `OPENQUERY`, `DBCC`,
  `WRITETEXT`, `UPDATETEXT`, `READTEXT` appears outside a
  string, comment or quoted identifier, and no identifier begins with `xp_` or `sp_`. `sql_query`
  accepts only `read`. `INTO` is on the list because `SELECT … INTO` creates a table on both
  engines, and PostgreSQL's `EXPLAIN ANALYZE DELETE …`, which executes, is `other`.
- **ACT-38** `dml`: the first keyword is `INSERT`, `UPDATE`, `DELETE` or `MERGE` (or `WITH`
  leading to one of them). `ddl`: the first keyword is `CREATE`, `ALTER`, `DROP`, `TRUNCATE`,
  `GRANT`, `REVOKE` or `DENY`. Everything else is `other` and is refused by both tools.
  `sql_execute` accepts `dml` and, when `write_classes` includes it, `ddl`; then applies
  `statement_allowlist` if set, as ACT-34 patterns of the `command` kind over the statement as
  the agent wrote it (an empty list is no restriction). Classification is a control in depth
  behind the least-privilege login of ACT-85, not a parser that promises to understand every
  dialect; the guide says so.

### 13.7.3 Decisions

- **ACT-39** `authorize` returns `{ allowed: true, operation: 'read' | 'write' | 'shell' | 'act',
class? }` or `{ allowed: false, reason }` with `reason` one of `method`, `path`, `header`,
  `body_size`, `operation`, `statement_count`, `statement_class`, `statement_pattern`, `command`,
  `command_metacharacter`, `command_size`, `origin`, `element`. The reason is returned to the agent in the tool error and
  audited; the pattern or origin list itself is not returned.
- **ACT-40** A call is a **non-read call** when `authorize` classifies it as `write`, `shell` or
  `act`: every `sql_execute`, every `ssh_run` and `winrm_run`, every `http_request` whose method
  is not `GET`, `HEAD` or `OPTIONS`, and every `browser_click` and `browser_type`.
  `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_screenshot` and
  `browser_close` are `read` for policy purposes. Non-read calls are subject to `confirm_writes`
  (13.8).

## 13.8 Confirmation through elicitation

- **ACT-41** When a target's `policy.confirm_writes` is `true` and the call is a non-read call,
  the engine MUST obtain a human confirmation through MCP elicitation before it fetches the
  credential, opens a connection or acts in a session. The confirmation asks for exactly one
  boolean; it never asks for a secret, an address or free text (the MCP specification forbids
  requesting sensitive information in form mode, and vaultgate has nothing else to ask).
- **ACT-42** On protocol version `2026-07-28` the request is an `InputRequiredResult` (the
  multi-round-trip pattern), which suits the stateless handler of MCP-1: nothing about the pending
  call is held in memory. The result is exactly:

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "confirm": {
      "method": "elicitation/create",
      "params": {
        "mode": "form",
        "message": "vaultgate: <client name> asks to run <tool> on target \"<name>\" (<connector>, <destination summary>).\n\nThe operation, every line of it quoted with \"> \":\n> <operation summary, one quoted line per line>\n\n[NOT SHOWN: … — present only when the summary is an excerpt, ACT-43]\n\nAllow this one call? It expires in 2 minutes and cannot be reused.",
        "requestedSchema": {
          "type": "object",
          "properties": {
            "confirm": {
              "type": "boolean",
              "title": "Allow this call",
              "description": "Tick to let vaultgate run the operation shown above, once.",
              "default": false
            }
          },
          "required": ["confirm"]
        }
      }
    }
  },
  "requestState": "<opaque, ACT-44>"
}
```

- **ACT-43** `<destination summary>` is the host (and database, base path or origin) only;
  `<operation summary>` is the method and path, the statement, the command or, for a browser
  action, the page URL and the element's accessible name and the text to type, built from the
  agent's arguments and the target's metadata and passed through the scrubber (13.9) like any
  output. The message never contains an injected value, a policy pattern or a vault item id.

  The summary is the last line of defence against a prompt-injected agent talking an honest human
  into a call, so it is never shortened in silence. An operation longer than 1 KiB is shown as its
  first 768 characters and its last 192, joined by `…` on lines of its own, and the message then
  carries a line of vaultgate's own — outside the quoted block, where the agent's text cannot
  reach — saying how many characters are missing and the SHA-256 of the whole operation. Showing
  the tail matters: a payload appended to a long prelude is exactly what a head-only cut hides.
  vaultgate does not refuse to confirm a long operation, because refusing would push an operator
  towards `confirm_writes: false`, which is the weaker of the two states this clause exists to
  protect.

  Every line of the summary is prefixed with a quote marker (`>` and a space) and the message says so, so an agent cannot
  reproduce the message's own trailer: a line it writes is a quoted line, and the trailer is the
  only unquoted one. It is built before the credential is fetched (ACT-41), so at that
  point there is no injected value to scrub; the canary suite of ACT-53 asserts it is clean.

- **ACT-44** `requestState` is `base64url(payload) + "." + base64url(HMAC-SHA256(payload))` under
  a key derived from `VAULTGATE_SECRET_KEY` (HKDF purpose `vaultgate/actions-confirmation/v1`),
  where `payload` is JSON of `{ v: 1, nonce, target_id, revision, tool, client_id, token_prefix,
args_sha256, issued_at, expires_at }` and `expires_at` is `issued_at + 120 000`. It carries no
  secret and no argument text; the client learns nothing from it that it did not send.
- **ACT-45** The client retries the same `tools/call` with `inputResponses.confirm` and the echoed
  `requestState`. The engine verifies the HMAC, the expiry, that `client_id` and `token_prefix`
  match the presenting token, that `target_id` and `revision` match the target as it is now
  (a target edited in between invalidates the confirmation), and that `args_sha256` equals the
  SHA-256 of the canonical JSON of the retried arguments. Any mismatch fails with
  `confirmation_invalid`; an expired state fails `confirmation_expired`.
- **ACT-46** The `nonce` is single-use: it is written to `action_calls.confirmation_nonce`
  (unique index) inside the same transaction that records the call, before the connector runs;
  a second retry with the same state fails `confirmation_reused`. Nonces are 16 random bytes.
  The engine also refuses a nonce it finds already consumed before it fetches the credential;
  the transaction is the backstop against a race between two retries.
- **ACT-47** The `ElicitResult` is honoured as: `action: "accept"` with `content.confirm === true`
  runs the call; `accept` with `confirm` false or absent, `decline` and `cancel` fail with
  `confirmation_declined` (`accept` or `decline`) or `confirmation_cancelled` (`cancel`) and are
  audited as such. No retry is offered by the server; the agent may call again and a new
  confirmation is requested.
- **ACT-48** Capability check: the client's elicitation support is read from the request's
  `_meta["io.modelcontextprotocol/clientCapabilities"].elicitation` (an object with `form` or an
  empty object means form mode). A request that carries no such envelope — which is every
  request on a protocol version older than `2026-07-28` — declares no form-mode elicitation, and
  a non-read call on a confirmed target then fails **before anything else happens** with
  `confirmation_unavailable` and the fixed message "this target requires a human confirmation and
  your client does not support MCP elicitation; ask the operator to use a client that does, or to
  lift the requirement for this target". The engine never downgrades a confirmed target to
  unconfirmed.

  There is no in-band fallback on the older wire, and there cannot be one in this deployment
  model. An earlier draft of this clause required the engine to fall back to the SDK's
  server-to-client `elicitation/create` request when the negotiated version predates the
  multi-round-trip pattern but the client declared `elicitation` at initialisation. That is
  unimplementable under MCP-1: the 2025 wire declares the capability once, in `initialize`, and
  the stateless handler builds a fresh server per HTTP request that never sees that message. The
  SDK resolves the per-request capability view from the request envelope on a 2026-07-28 instance
  and from the `initialize`-declared state on a 2025-era one, and documents that "per-request
  instances that never saw an initialize (stateless legacy) hold nothing, so gates refuse there";
  its legacy shim, asked to fulfil the request anyway, answers "no client capabilities are
  available on this connection — per-request legacy serving cannot receive server-to-client
  requests". The refusal is not merely equivalent to attempting the fallback — it is better:
  the attempt returns an untyped `isError` text result instead of the `confirmation_unavailable`
  code an agent can act on, records no `action_calls` row at all (ACT-60 records nothing for a
  call that ends in a confirmation request, and the shim fails after the handler has returned),
  and still shows no human a prompt. A deployment that wants confirmations for a 2025-wire client
  would have to hold a session for it, which MCP-1 forbids; the supported answer is a client on
  `2026-07-28`, or `confirm_writes: false` with the review that ACT-63 provides.

- **ACT-49** A target with `confirm_writes: false` relies on the client-side prompt the
  annotations invite (13.6.1) and on the operator's grant; `actions_list_targets` reports the
  difference so an agent can warn its user. The account page defaults `confirm_writes` to
  `true` for every new target whose policy allows a non-read operation.

## 13.9 Secret handling

- **ACT-50** Injected values are fetched from the vault through `VaultClient` at the moment of
  the call (after policy, rate limit and confirmation), held in memory only for the call, and
  overwritten with zeros when the call ends (`Buffer.fill(0)`; string copies a connector library
  or the browser sidecar makes are outside vaultgate's control and are the reason connectors are
  separate sub-modules with the smallest possible surface). A value the run itself obtains joins
  the same holder and is zeroed with it. Nothing about them is cached, except the adapter token
  of ACT-82, which lives in the adapter's own in-process cache, and the scrub list a browser
  session keeps for its lifetime (14.7).
- **ACT-51** Before any connector output, error text, snapshot or elicitation message leaves the
  engine, the scrubber replaces every occurrence of every injected value and of each of its
  encoded variants with `[redacted:<field>]`. The variants are: the raw value;
  `encodeURIComponent` of it; the `application/x-www-form-urlencoded` form (`+` for space);
  standard base64 and base64url, with and without padding; the `basic` credential
  `base64(username:value)`, whose login name is the one the mapping names or, where the connector
  authenticates with a pair whose name the destination holds (`winrm`, 14.6), the destination's;
  the JSON string escape of the value; and, for values containing
  characters outside printable ASCII, the `\uXXXX`-escaped JSON form. Matching is exact-substring
  on the buffered output, **on its bytes, before any encoding vaultgate itself applies**: base64
  is positional, so no variant of a value appears in the base64 of a buffer that merely contains
  it, and a connector that encoded a body, a stream or a binary column before the scrubber saw it
  would hand the agent the credential verbatim. Connectors therefore return raw bytes and the
  engine encodes after it has scrubbed. It is applied to `stdout`, `stderr`, `body`, `snapshot`,
  every response header value, every `detail` string and the `message` of ACT-43. Values are scrubbed whatever
  their length, so a short secret costs false positives rather than a leak.
- **ACT-52** Output is captured up to `max_output_bytes` plus a guard band equal to the length of
  the longest variant of ACT-51, scrubbed, then cut at `max_output_bytes` with `truncated: true`,
  so a value straddling the cut cannot survive. The ceiling for `max_output_bytes` is 1 MiB and
  the default is 256 KiB.
- **ACT-53** Injected values never enter `action_calls`, `action_sessions`, `audit_events`, the
  logger (they are added to the pino redaction backstop by field name, OPS-1) or an error message.
  The canary-containment suite (11.2) gains a fixture target per connector whose credential is a
  canary string and asserts that no canary, in any ACT-51 variant, appears in any tool result,
  snapshot, screenshot-side DOM, audit row, log line or elicitation message when a fake
  destination echoes its request back.
- **ACT-54** The layer never reveals through timing or errors whether a vault item exists to a
  client that is not granted the target (ACT-16 ordering), and `credential_unavailable` carries
  one fixed message for a locked vault, a missing item and a missing field alike; the operator
  sees the precise reason on the account page.

Sections 13.10 to 13.18 — destinations and the network, the limits, the audit trail, the
storage, the configuration, the module layout, the error codes, the non-goals and the
verification — are in
[13a Actions in operation](13a-actions-operations.md); the section numbers and the `ACT-n`
sequence continue there unchanged.
