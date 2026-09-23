# 13 Actions: typed, policy-gated use of vault credentials

> **Status: M9 in progress — engine core landed; tools and pages follow.** This section
> specifies the actions layer decided in
> [ADR 0007](../adr/0007-typed-actions-with-operator-policy.md) and sequenced as milestones
> M9 to M15 in [`PLAN.md`](../PLAN.md). Landed with M9's first pull request: configuration
> (13.14), scopes and consent (13.5), storage and maintenance (13.13), targets and grants
> (13.3, 13.4), policy patterns (13.7.1), confirmation state (13.8), secret handling (13.9),
> limits (13.11), the engine in `src/actions/` with the resolution order of ACT-16, the
> `action_calls` trail and its export stream (13.12), the layering rules (13.15) and the
> `http` connector's document schemas (14.2). Not yet: any MCP tool (13.6), the account
> pages (13.3.2), the `http` runtime and every other connector; until the tools land, the
> vault tools of section 06 are the whole MCP surface. The per-connector contracts are in
> [14 Action connectors](14-actions-connectors.md); the `ACT-n` sequence continues there.

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
  `credential` only).
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
  needs at least one `actions:*` scope and lists only the targets that scope set can call.
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
  to the engine (13.15).
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
  host, no `..` segment, no fragment); `headers` (object of string → string, ≤ 32 entries, names
  matched case-insensitively against the policy allowlist); `body` (string ≤ `max_body_bytes`, or
  a JSON value which is serialised with `Content-Type: application/json` when the agent sets no
  content type). `path` is appended to the destination's `base_url`; the resolved URL MUST stay
  under `base_url` after normalisation or the call fails `policy_denied` (`reason: path`).
- **ACT-21** Output: `status` (integer), `headers` (only the names in the policy's
  `response_headers` list, default `content-type`, `content-length`, `location`, `retry-after`),
  `body` (text; binary bodies are returned base64 with `body_encoding: "base64"`), `bytes` (size
  before the cap), `truncated`, `duration_ms`. A non-2xx status is a normal result, not an error;
  connection and TLS failures are errors.
- **ACT-22** The agent cannot set `Authorization`, `Cookie`, `Host`, `Proxy-*`, `Transfer-Encoding`
  or any header the credential mapping injects; such a header fails `policy_denied`
  (`reason: header`). Redirects are not followed unless `policy.follow_redirects` is `true`, and
  then at most 2 hops, each re-validated by 13.10 and required to stay under `base_url`; the
  injected credential is re-applied only on hops that stay under `base_url`.

### 13.6.4 `sql_query` and `sql_execute`

- **ACT-23** Input for both: `target`; `statement` (string ≤ 64 KiB); `params` (array ≤ 100 of
  string, number, boolean or `null`, bound positionally to the engine's native placeholders,
  `$1…$n` for PostgreSQL and `@p1…@pn` for SQL Server). There is no string interpolation path:
  a placeholder without a matching parameter or a parameter without a placeholder fails
  `invalid_arguments`.
- **ACT-24** `sql_query` output: `columns` (array of `{ name, type }`, `type` the engine's type
  name), `rows` (array of arrays of JSON scalars; dates as ISO 8601 strings, binary as base64,
  decimals as strings), `row_count`, `truncated` (rows beyond `max_rows` were dropped),
  `duration_ms`.
- **ACT-25** `sql_execute` output: `rows_affected`, plus `columns`/`rows`/`truncated` when the
  statement returns rows (`RETURNING`, `OUTPUT`), `duration_ms`. The statement runs in its own
  transaction that commits on success and rolls back on any error or on the timeout.
- **ACT-26** Statement classification (13.7.2) runs before any connection is opened, on both
  tools, and the classification result (`read`, `dml`, `ddl`, `other`) is audited.

### 13.6.5 `ssh_run` and `winrm_run`

- **ACT-27** Input for both: `target`; `command` (string ≤ 16 KiB; no NUL byte; a newline or
  carriage return is allowed only on a target with `any_command: true`); `stdin` (optional string
  ≤ 64 KiB, written to the process's standard input and then closed). Output for both:
  `exit_code` (integer, or `null` when the channel closed without one), `stdout`, `stderr`,
  `truncated`, `duration_ms`. `stdout` and `stderr` are captured separately and each is capped at
  `max_output_bytes`.
- **ACT-28** `ssh_run` opens one exec channel per call, requests no PTY, no agent forwarding, no
  X11, no environment variables and no port forwarding, and closes the connection when the call
  ends. `winrm_run` creates one WS-Management shell per call (`cmd` or `powershell` per the
  target's `shell`; for `powershell` the command is sent as an encoded command), collects output,
  signals termination on timeout and deletes the shell.

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
  run of characters except `/` (paths) or a newline (commands); `**` matches any run including
  `/` (paths only); every other character is literal; matching is anchored at both ends and
  case-sensitive except for HTTP header names and methods. A pattern list matches when any
  pattern matches the whole subject.
- **ACT-35** HTTP subjects are the request path plus query, relative to `base_url`, after
  normalisation (percent-decoding of unreserved characters, dot-segment removal). Command subjects
  are the exact `command` string. Browser origins are compared exactly (scheme, host, port) and
  are never patterns. A pattern that would allow everything (`*`, `**`) is refused at save for
  commands unless `any_command` is what the operator means; for paths `/**` is allowed and is the
  documented way to say "the whole API". Each `allowed_paths` pattern is itself checked at save:
  it must start with `/`, must not climb above `base_url`, and must be written in the normalised
  form it will be matched against.

### 13.7.2 SQL classification

- **ACT-36** A statement is tokenised (strings, quoted identifiers, `--` and `/* */` comments,
  dollar-quoted strings on PostgreSQL) and MUST be exactly one statement: a `;` outside a string or
  comment that is followed by anything other than whitespace fails `policy_denied`
  (`reason: statement_count`). Comments are stripped before classification.
- **ACT-37** `read`: the first keyword is `SELECT`, `WITH` or `EXPLAIN`, and no keyword of the
  set `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `EXEC`, `EXECUTE`, `CALL`, `CREATE`, `ALTER`,
  `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`, `COPY`, `LOCK`, `SET`, `USE`, `BACKUP`,
  `RESTORE`, `SHUTDOWN`, `RECONFIGURE`, `WAITFOR`, `OPENROWSET`, `OPENQUERY` appears outside a
  string, comment or quoted identifier, and no identifier begins with `xp_` or `sp_`. `sql_query`
  accepts only `read`. `INTO` is on the list because `SELECT … INTO` creates a table on both
  engines.
- **ACT-38** `dml`: the first keyword is `INSERT`, `UPDATE`, `DELETE` or `MERGE` (or `WITH`
  leading to one of them). `ddl`: the first keyword is `CREATE`, `ALTER`, `DROP`, `TRUNCATE`,
  `GRANT`, `REVOKE` or `DENY`. Everything else is `other` and is refused by both tools.
  `sql_execute` accepts `dml` and, when `write_classes` includes it, `ddl`; then applies
  `statement_allowlist` if set. Classification is a control in depth behind the least-privilege
  login of ACT-85, not a parser that promises to understand every dialect; the guide says so.

### 13.7.3 Decisions

- **ACT-39** `authorize` returns `{ allowed: true, operation: 'read' | 'write' | 'shell' | 'act',
class? }` or `{ allowed: false, reason }` with `reason` one of `method`, `path`, `header`,
  `body_size`, `operation`, `statement_count`, `statement_class`, `statement_pattern`, `command`,
  `command_size`, `origin`, `element`. The reason is returned to the agent in the tool error and
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
        "message": "vaultgate: <client name> asks to run <tool> on target \"<name>\" (<connector>, <destination summary>).\n\n<operation summary>\n\nAllow this one call? It expires in 2 minutes and cannot be reused.",
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
  `<operation summary>` is the method and path, the statement (first 1 KiB), the command (first
  1 KiB) or, for a browser action, the page URL and the element's accessible name and the text
  to type, built from the agent's arguments and the target's metadata and passed through the
  scrubber (13.9) like any output. The message never contains an injected value, a policy
  pattern or a vault item id. It is built before the credential is fetched (ACT-41), so at that
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
- **ACT-48** Capability check and fallback: the client's elicitation support is read from the
  request's `_meta["io.modelcontextprotocol/clientCapabilities"].elicitation` (an object with
  `form` or an empty object means form mode). On a negotiated protocol version that predates
  the multi-round-trip pattern but declared `elicitation` at initialisation, the engine uses the
  SDK's in-band server-to-client `elicitation/create` request with the same `message` and
  `requestedSchema`, within the same 2 minute bound, holding the pending call for that request
  only. When the client declares no form-mode elicitation at all, the call fails **before
  anything else happens** with `confirmation_unavailable` and the fixed message "this target
  requires a human confirmation and your client does not support MCP elicitation; ask the
  operator to use a client that does, or to lift the requirement for this target". The engine
  never downgrades a confirmed target to unconfirmed.
- **ACT-49** A target with `confirm_writes: false` relies on the client-side prompt the
  annotations invite (13.6.1) and on the operator's grant; `actions_list_targets` reports the
  difference so an agent can warn its user. The account page defaults `confirm_writes` to
  `true` for every new target whose policy allows a non-read operation.

## 13.9 Secret handling

- **ACT-50** Injected values are fetched from the vault through `VaultClient` at the moment of
  the call (after policy, rate limit and confirmation), held in memory only for the call, and
  overwritten with zeros when the call ends (`Buffer.fill(0)`; string copies a connector library
  or the browser sidecar makes are outside vaultgate's control and are the reason connectors are
  separate sub-modules with the smallest possible surface). Nothing about them is cached, except
  the adapter token of ACT-82 and the scrub list a browser session keeps for its lifetime (14.7).
- **ACT-51** Before any connector output, error text, snapshot or elicitation message leaves the
  engine, the scrubber replaces every occurrence of every injected value and of each of its
  encoded variants with `[redacted:<field>]`. The variants are: the raw value;
  `encodeURIComponent` of it; the `application/x-www-form-urlencoded` form (`+` for space);
  standard base64 and base64url, with and without padding; the `basic` credential
  `base64(username:value)`; the JSON string escape of the value; and, for values containing
  characters outside printable ASCII, the `\uXXXX`-escaped JSON form. Matching is exact-substring
  on the buffered output; it is applied to `stdout`, `stderr`, `body`, `snapshot`, every response
  header value, every `detail` string and the `message` of ACT-43. Values are scrubbed whatever
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

| Limit                       | Default                                           | Key     | Beyond it                                 |
| --------------------------- | ------------------------------------------------- | ------- | ----------------------------------------- |
| Calls per target            | `policy.rate_limit_per_minute`, 60                | target  | `rate_limited` with `retry_after_s`       |
| Calls per client            | 120 / min across all targets                      | client  | `rate_limited`                            |
| In-flight calls per target  | 4                                                 | target  | `rate_limited`                            |
| In-flight calls per client  | 8                                                 | client  | `rate_limited`                            |
| Timeout per call            | `policy.timeout_ms`, 30 000; ceiling 300 000      | call    | `timeout`; the connector cancels the work |
| Output per call             | `policy.max_output_bytes`, 256 KiB; ceiling 1 MiB | call    | `truncated: true`                         |
| Request body (`http`)       | `policy.max_body_bytes`, 256 KiB; ceiling 4 MiB   | call    | `policy_denied` (`body_size`)             |
| Rows (`sql_query`)          | `policy.max_rows`, 500; ceiling 10 000            | call    | `truncated: true`                         |
| Browser sessions per client | `policy.max_sessions`, 1; ceiling 4               | client  | `session_limit`                           |
| Browser session lifetime    | `policy.session_ttl_s`, 900 idle; 3 600 absolute  | session | `session_expired`                         |
| Confirmations pending       | 2 minutes each                                    | state   | `confirmation_expired`                    |

- **ACT-59** Limits are the in-memory token buckets of OPS-6 (single replica, 10 000 keys), sit
  inside the per-token limit of MCP-5, and are applied before confirmation so an agent cannot
  spend confirmations to probe them. A rate-limited call is audited with outcome
  `denied:rate_limited`.

## 13.12 Audit

- **ACT-60** Every call appends the MCP-13 audit event (tool, client, token prefix, outcome,
  duration) **and** one `action_calls` row: `id`, `at`, `target_id`, `target_name`, `connector`,
  `revision`, `tool`, `session_id_hash` (the SHA-256 of the browser session id, ACT-96), `client_id`, `token_prefix`, `operation` (`read` \|
  `write` \| `shell` \| `act`), `classification` (SQL class, HTTP method, `command`, or the browser
  page URL), `arguments` (JSON of the tool arguments minus injected values and minus any header
  the policy did not allow, capped at 4 KiB with `arguments_truncated`), `output_bytes`,
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
  audit export (OPS-5) as a second stream (`--stream actions`; the account page export offers both).
- **ACT-63** The account page shows, per target, the last 50 calls with their outcome and
  elicitation result, open sessions, and an "unexpected write" view listing every non-read call
  whose elicitation is not `accepted`, so a target with `confirm_writes: false` is reviewable.

## 13.13 Storage

Migration `004-actions` adds four tables (conventions of 07.1):

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
| `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND` | `false` | Allows `ssh`/`winrm` targets to be saved with `any_command: true` (ACT-88). Turning it off later makes such targets refuse every call. |

- **ACT-67** The connector switches are meaningful only with the master switch on; a connector
  switch without the master is a start-up warning. A disabled connector keeps its targets in the
  store, hides them from agents, and answers `connector_disabled` to a call that names one by
  accident (after the grant check, ACT-16).
- **ACT-68** The start-up configuration summary (CFG-3) lists the eight variables; `/readyz` does
  not mention the layer (OPS-4), except that a signed-in operator sees `browser.ready` when the
  connector is enabled (whether the sidecar answered its last probe). Section 08's reference table
  gains the rows when M9 lands.

## 13.15 Architecture and dependencies

- **ACT-69** The engine and connectors live in `src/actions/` with this layout, every file under
  300 lines (11.1). Where one concern outgrew a file it is split by cohesion, never by line
  count; the names below are the modules as they exist (M9's first pull request) or are
  planned for a later milestone (marked so):

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
  scrub.ts             injected values (ACT-50), variant generation and replacement (ACT-51, 52)
  limits.ts            per-target and per-client buckets and in-flight counters (ACT-59)
  sessions.ts          closing action_sessions on the revocation paths; the browser session registry is M15
  audit.ts             the actions.* audit events (ACT-7)
  pages/               account-page section (ACT-5, 6), composed by src/http/ (planned)
  connectors/
    connector.ts       the connector interface (14.1)
    registry.ts        schemas of every connector; runtimes loaded for enabled connectors only (ACT-73)
    http/              document schemas now; request builder, injection modes, pinned transport use (planned)
    graph/             token exchange, cache, refresh-token write-back (planned)
    sql/               tokeniser and classifier; mssql/ and postgres/ drivers (planned)
    ssh/               ssh2 client wrapper, host-key pinning (planned)
    winrm/             WS-Management client, shell lifecycle (planned)
    browser/           CDP client, login sequence, origin interception, snapshot and masking (planned)
```

- **ACT-70** Dependency-cruiser gains a layer: `src/actions/` MAY import `result`, `config`,
  `logger`, `net`, `crypto`, `scopes`, `vault`, `storage` and `audit`; it MUST NOT import
  `identity/`, `oauth/`, `mcp/`, `bitwarden/` or `http/` except type-only imports from
  `identity/` (the guard and session types its pages need, injected by composition) and from
  `mcp/` (the `Tool` shape). `src/mcp/tools/actions.ts` imports the engine's public interface;
  `src/http/` composes the pages; the revocation paths of `oauth/` reach sessions through a
  callback the composition layer wires, never by import. `identity/`, `oauth/` and `bitwarden/`
  never import `actions/`.
- **ACT-71** ARCH-2 stands: no connector imports `child_process`; `ssh_run` and `winrm_run`
  execute on the remote host only, and the browser runs in the sidecar, never in the vaultgate
  process or image. The lint rule is unchanged and the module-graph rule adds `actions/` to the
  list it applies to.
- **ACT-72** Runtime dependencies are added one per connector milestone with the QG-9
  justification: `pg` and `mssql` (M11), `ssh2` (M12), for WinRM either nothing (hand-written
  client) or one evaluated package (M13), and `playwright-core` (M15; the driver only, it downloads
  no browser). The `http` connector and the `graph` adapter add no dependency. Native addons
  remain unacceptable; a package whose install compiles or downloads anything is rejected.
- **ACT-73** The engine is constructed only when `VAULTGATE_ENABLE_ACTIONS=true`; otherwise
  `src/main.ts` passes no engine, the MCP tool registry registers no actions tool, the scope
  registry advertises no actions scope, the account page renders no section, and the connectors'
  modules are never imported (dynamic import at engine construction, so knip and the module-graph
  rules still see them).

## 13.16 Error codes

| Code                         | Meaning                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions_disabled`           | `VAULTGATE_ENABLE_ACTIONS` is off (only reachable by a token issued while it was on).                                                             |
| `connector_disabled`         | The target's connector is switched off (ACT-67).                                                                                                  |
| `unknown_target`             | No enabled, granted target of that name for this client.                                                                                          |
| `target_disabled`            | The target exists and is granted but is disabled.                                                                                                 |
| `target_invalid`             | The stored target fails schema validation (ACT-1); the operator page shows why.                                                                   |
| `not_granted`                | The target exists but this client has no grant.                                                                                                   |
| `insufficient_scope`         | The token does not hold the scope the tool needs (ACT-16). The MCP layer answers this with the OAUTH-33 challenge before the engine is reached.   |
| `invalid_arguments`          | Argument shape or parameter binding problem (ACT-20, 23, 27, 29…33).                                                                              |
| `policy_denied`              | The policy refused the operation; `detail.reason` is one of ACT-39's reasons.                                                                     |
| `rate_limited`               | ACT-59; `detail.retry_after_s`.                                                                                                                   |
| `confirmation_unavailable`   | The target requires confirmation and the client cannot elicit (ACT-48).                                                                           |
| `confirmation_declined`      | The human declined or did not tick the box (ACT-47).                                                                                              |
| `confirmation_cancelled`     | The human dismissed the prompt (ACT-47).                                                                                                          |
| `confirmation_expired`       | The retried `requestState` is older than 2 minutes (ACT-45).                                                                                      |
| `confirmation_invalid`       | The `requestState` does not verify or does not match the retried call (ACT-45).                                                                   |
| `confirmation_reused`        | The nonce was already consumed (ACT-46).                                                                                                          |
| `credential_unavailable`     | The vault is locked, or the item or field is missing (one fixed message, ACT-54).                                                                 |
| `credential_rotation_failed` | The `graph` refresh-token write-back failed (ACT-83).                                                                                             |
| `destination_refused`        | The destination resolved to an address the private-range rule refuses (ACT-56).                                                                   |
| `host_key_mismatch`          | SSH host key differs from the pinned one (ACT-87).                                                                                                |
| `tls_error`                  | Certificate verification failed (ACT-57).                                                                                                         |
| `connection_failed`          | The destination refused or reset the connection, or DNS failed.                                                                                   |
| `authentication_failed`      | The destination rejected the injected credential.                                                                                                 |
| `timeout`                    | The policy timeout elapsed; work was cancelled (ACT-25, ACT-90).                                                                                  |
| `upstream_error`             | The destination reported an error after authentication (SQL error, WinRM fault); `detail.message` carries its text, scrubbed and capped at 1 KiB. |
| `browser_unavailable`        | The sidecar did not answer on `VAULTGATE_ACTIONS_BROWSER_CDP_URL` (ACT-92).                                                                       |
| `login_failed`               | `browser_open` could not complete the sign-in (ACT-29, ACT-94); `detail.stage` is `form`, `submit`, `totp` or `landing`.                          |
| `unknown_session`            | No open session of that id for this client (ACT-16).                                                                                              |
| `session_expired`            | The session passed its idle or absolute TTL, or was closed by a revocation path (ACT-96).                                                         |
| `session_limit`              | The client already holds `max_sessions` sessions on this target (ACT-96).                                                                         |
| `element_not_found`          | The `ref` is not in the current page (ACT-32).                                                                                                    |

- **ACT-74** Every code has one fixed `message`; `detail` is the only variable part, is scrubbed
  (ACT-51), and never contains a destination address, an origin list, a vault item id or a
  policy pattern. Codes are stable API like tool names (12.5).

## 13.17 Non-goals

- No file transfer or file access tool (no SFTP, no `scp`, no download through the browser, no
  reading a path on the remote host other than through a command the allowlist admits).
- No process execution anywhere except on the remote host of an `ssh` or `winrm` target and
  inside the browser sidecar; nothing runs on the vaultgate host (ARCH-2).
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
- No connectors beyond the six (SMTP, S3, Kubernetes and the like are declined until each has a
  policy model as tight as these; a generic "TCP" connector is declined outright).

## 13.18 Verification

- **ACT-75** Each connector ships with contract tests against a fake transport that cover every
  policy reason, every error code it can raise, the scrubber over a destination that echoes its
  request, the caps and the timeout, plus the ACT-53 canary suite; and a live test, run manually
  and recorded in the milestone's pull request, against the maintainer's own systems (an HTTPS
  API and a Microsoft 365 tenant for `http`/`graph`, a SQL Server and a PostgreSQL database for
  `sql`, a Linux host for `ssh`, a Windows host for `winrm`, two of the maintainer's own web
  applications for `browser`).
- **ACT-76** The elicitation flow is tested in-process with the SDK client declaring, in turn,
  form-mode elicitation on `2026-07-28`, elicitation on an older negotiated version, and no
  elicitation, asserting the three behaviours of ACT-42 and ACT-48 and every outcome of ACT-47,
  with replay, expiry, edited-target and altered-argument retries refused (ACT-45, 46).
- **ACT-77** The classifier (13.7.2) has a corpus of statements per engine, including comment and
  string tricks (`SELECT 1; DROP …`, `SELECT '…; DROP' …`, `/* */` splits, dollar quoting,
  `SELECT … INTO`, `WITH … AS (DELETE …)`, `EXEC` inside a string), and every corpus entry is a
  named test.
