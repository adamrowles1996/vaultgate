# Tools and scopes

Every MCP tool vaultgate exposes, the scope it needs, what it takes, what it returns, and what it
never returns. Tool and scope names are stable within a major version. Specification:
[06 MCP surface](../spec/06-mcp-surface.md) and [03 § 3.8 Scopes](../spec/03-oauth.md).

## Scopes

| Scope            | Grants                                                                          | Enabled by default |
| ---------------- | ------------------------------------------------------------------------------- | ------------------ |
| `vault:read`     | Search and list items, folders and collections; item summaries without secrets. | yes                |
| `vault:reveal`   | Reveal one secret field at a time: passwords, TOTP codes, notes, hidden fields. | yes                |
| `vault:generate` | Generate random passwords and passphrases; nothing is stored.                   | yes                |
| `vault:write`    | Create, update and trash items; create folders.                                 | no                 |

No scope implies another. A token holds the scopes the operator ticked on the consent page, and
a tool is usable only when the token holds its scope _and_ the deployment has that scope
enabled. `tools/list` returns only the tools the token can call, so an agent is never shown a
tool it cannot use; calling one anyway is answered `403` with a `WWW-Authenticate` challenge
that names every scope the call needs.

### Enabling `vault:write`

Writes are off unless the deployment sets:

```bash
VAULTGATE_ENABLE_WRITE_SCOPE=true
```

then restarts. Clients can request `vault:write` from that point; existing consents are not
widened, so a client connected earlier must be disconnected on the console's Agents page and connected
again with the scope ticked. Setting the variable back to `false` takes effect on restart for
every existing token at once, without revoking anything: a token that still holds `vault:write`
simply no longer has it in effect.

## Tool reference

Every tool returns structured JSON (`structuredContent`) and the same JSON as text. Every result
schema is strict: a field not listed here cannot appear in a result. Failures return
`{ "error": "<code>", "message": "…" }` with `isError: true`; the codes are listed at the end.

### `vault_status` (`vault:read`)

Reports the vault connection. Call it first when another tool reports `vault_unavailable`.

| Input | Output                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none  | `server_url`, `user_email_masked` (`a***@example.com` or `null`), `state` (`unlocked`, `locked`, `unauthenticated`, `unavailable`), `last_sync_at`, `item_count` (items not in the trash) |

Never returns item data or secrets.

### `search_items` (`vault:read`)

Finds items by free text matched against name, username and URIs, with optional filters.

| Input           | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `query`         | Free text; omit to filter only.                                    |
| `type`          | `login`, `secureNote`, `card`, `identity` or `sshKey`.             |
| `folder_id`     | From `list_folders`.                                               |
| `collection_id` | From `list_collections`.                                           |
| `url`           | Match login items whose URIs contain this text.                    |
| `include_trash` | Default `false`.                                                   |
| `limit`         | 1 to 50, default 50. There is no paging: narrow the query instead. |

Returns `items` (a list of item summaries, below) and `truncated` (`true` when the limit cut the
result short). Never returns passwords, notes or any other secret value.

An **item summary** is: `id`, `name`, `type`, `folder_id`, `organization_id`, `collection_ids`,
`favorite`, `revision_date`, `deleted_date` (set when the item is in the trash), `login`
(`username`, `uris`, `has_password`, `has_totp`; `null` for non-login items), `has_notes`, and
`custom_fields` (each `name`, `kind`, `value`; `value` is always `null` for `hidden` and `linked`
fields).

### `get_item` (`vault:read`)

One item's metadata by id.

| Input     | Output                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item_id` | `item` (an item summary) and `secrets`: `password`, `totp`, `notes`, `card`, `identity`, `ssh_private_key`, each `{ "present": true \| false }`, and `hidden_fields` (the names of hidden custom fields) |

Secret fields are reported as present or absent only. Use `get_secret` for a value.

### `list_folders` (`vault:read`)

No input. Returns `folders`: each `id` and `name`. No items, no secrets.

### `list_collections` (`vault:read`)

No input. Returns `collections`: each `id`, `name` and `organization_id`, for the organisation
collections the account can see. No items, no secrets.

### `get_secret` (`vault:reveal`)

The value of exactly one secret field of one item. This is the only tool that returns secret
material, and every call is audited with the item id and the field name.

| Input     | Meaning                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `item_id` | From `search_items` or `get_item`.                                                                                                                                                                                 |
| `field`   | `password`, `totp`, `notes`, `card.number`, `card.code`, `identity.<field>` (for example `identity.ssn`), `sshKey.privateKey`, or `custom.<name>` for a hidden custom field named in `get_item`'s `hidden_fields`. |

Returns `{ "kind": "text", "value": "…" }`, or for `totp` `{ "kind": "totp", "code": "123456",
"seconds_remaining": 17 }`. The TOTP seed is never returned, only the current code. An unknown
field name fails with `invalid_field` before the vault is touched; a field the item does not have
fails with `not_found`.

### `generate_password` (`vault:generate`)

| Input                                                                                           | Output     |
| ----------------------------------------------------------------------------------------------- | ---------- |
| `length` 8 to 128 (default 24); `uppercase`, `lowercase`, `numbers`, `special` (default `true`) | `password` |

Nothing is stored. To save a generated password without the agent seeing it, use
`create_item` or `update_item` with `generate_password: true` instead.

### `generate_passphrase` (`vault:generate`)

| Input                                                                                                                                    | Output       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `words` 3 to 20 (default 4); `separator` one character (default `-`); `capitalize` (default `false`); `include_number` (default `false`) | `passphrase` |

Nothing is stored.

### `create_item` (`vault:write`)

Creates a login or a secure note.

| Input                            | Meaning                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `type`                           | `login` or `secureNote`.                                                        |
| `name`                           | Required.                                                                       |
| `folder_id`, `notes`, `favorite` | Optional.                                                                       |
| `username`, `uris`               | Login fields, optional.                                                         |
| `generate_password: true`        | vaultgate generates a 24-character password and stores it without returning it. |
| `password`                       | An explicit value. Needs `vault:reveal` as well as `vault:write`.               |

`password` and `generate_password` are mutually exclusive (`conflicting_arguments`). Returns
`item`, the new item's summary; never the password or the notes.

### `update_item` (`vault:write`)

Partial update: only the fields given change.

| Input                                           | Meaning                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `item_id`                                       | Required.                                                         |
| `name`, `username`, `uris`, `notes`, `favorite` | Optional.                                                         |
| `folder_id`                                     | A folder id, or `null` to move the item out of its folder.        |
| `generate_password: true`                       | Rotate the password to a new generated one without seeing it.     |
| `password`                                      | An explicit value. Needs `vault:reveal` as well as `vault:write`. |

Returns `item`, the updated summary; never secret values. Writes are read-after-write
consistent: the tool waits (up to 5 s) until the new revision is visible before returning.

### `trash_item` (`vault:write`)

`item_id` in; `{ "item_id": "…", "trashed": true }` out. A soft delete the operator can undo in
Bitwarden. **There is no permanent delete tool.**

### `create_folder` (`vault:write`)

`name` in; `folder` (`id`, `name`) out. Use `list_folders` first to avoid duplicates.

## Actions

An off-by-default layer lets an agent _use_ a credential without receiving it: the operator
defines a target (an API, a database, a server, a Windows host or a website, plus the vault item
that signs in to it, an allowlist policy and the clients allowed to use it), and the agent calls
a connector tool by target name. Specification: [13 Actions](../spec/13-actions.md),
[13a Actions in operation](../spec/13a-actions-operations.md),
[14 Action connectors](../spec/14-actions-connectors.md) and
[ADR 0007](../adr/0007-typed-actions-with-operator-policy.md). The engine, the scopes, the MCP
tool surface below and the operator pages (the console's Computers pages, described in the
[Actions guide](actions.md)) exist today, and so do the `http` connector with `http_request`
(M9) and its Microsoft Graph credential adapter (M10), the `sql` connector with `sql_query`
and `sql_execute` (M11), the `ssh` connector with `ssh_run` (M12) and the `winrm` connector with
`winrm_run` (M13); the `browser` runtime lands with M15 in [`PLAN.md`](../PLAN.md), and until a
connector's runtime lands its tool is not listed on any deployment.

### Actions scopes

Every actions scope is marked risky on the consent page and none implies another. A scope is
advertised and effective only when `VAULTGATE_ENABLE_ACTIONS=true` _and_ its connector's switch
is on (`VAULTGATE_ACTIONS_ENABLE_HTTP`, `_SQL`, `_SSH`, `_WINRM`, `_BROWSER`); turning a switch
off takes effect for every existing token at once, exactly as for `vault:write`.

| Scope               | Grants                                                       | Tools             |
| ------------------- | ------------------------------------------------------------ | ----------------- |
| `actions:http`      | HTTP requests to granted `http` targets, signed by vaultgate | `http_request`    |
| `actions:sql.read`  | Read-only queries against granted `sql` targets              | `sql_query`       |
| `actions:sql.write` | Data changes on granted `sql` targets whose policy allows it | `sql_execute`     |
| `actions:ssh`       | One allowlisted command on a granted `ssh` target            | `ssh_run`         |
| `actions:winrm`     | One allowlisted command on a granted `winrm` target          | `winrm_run`       |
| `actions:browser`   | A signed-in browser session confined to allowed origins      | `browser_*` (M15) |

A token holding any of these also gets `actions_list_targets`. Calling it without one is
answered `403` with a challenge that lists every enabled actions scope as an any-of set
(`scope="actions:http actions:sql.read …"`, `error_description="actions_list_targets requires
any of …"`); calling a connector tool without its scope names that one scope.

### `actions_list_targets` (any `actions:*`)

No input. Returns `targets`: for each target this client has been granted, its `name` (the
`target` argument of every connector tool), the operator's `description` of what the destination
is and what to use it for, its `connector`, the `operations` the target policy and the token's
scopes allow (`read`, `write`, `shell`, `act`), `confirm_writes` (whether every non-read call
will ask a human for confirmation first), `engine` (`mssql` or `postgres`, `sql` targets only)
and `unrestricted: true` for a shell target that accepts any command. Disabled targets, targets
of a switched-off connector and targets the client is not granted do not appear. There is no
place in the result for a destination address, a credential field name or a policy pattern.

### `http_request` (`actions:http`)

`target` (a name from `actions_list_targets`), `method` (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
`DELETE` or `OPTIONS`), `path` (starting with `/`, at most 2 KiB, with an optional query string;
no scheme, host, fragment, `..` or empty segment), optional `headers` (at most 32) and an optional
`body` (a string, or a JSON object or array sent as `application/json` unless a content type
is given) in. The path is appended to the target's base URL and must stay under it; the method,
the path and query, every header name and the body size are checked against the target policy
before anything is sent (`policy_denied` with `detail.reason`), and `Authorization`, `Cookie`,
`Host`, `Content-Length`, `User-Agent`, `Transfer-Encoding`, `Proxy-*` and the header the
credential occupies can never be set. vaultgate adds the credential where the operator mapped
it (bearer, basic, a named header, a query parameter, or a Microsoft Graph access token it
obtains itself) and `User-Agent: vaultgate/<version>`,
connects once to the address it resolved and validated, and follows at most two redirects, only
under the base URL and only when the policy allows it; any other redirect is returned as it is.

Out: `status`, `headers` (only the names the policy returns, lower-cased), `body` (text, or
base64 with `body_encoding: "base64"` when the media type is not textual or the bytes are not
UTF-8), `bytes` received, `truncated` (cut at the target's output limit) and `duration_ms`. A
non-2xx status is a normal result: a `401` or `403` is reported as the status it is, never as
`authentication_failed`. Errors are reserved for a destination that could not be reached:
`connection_failed`, `tls_error`, `timeout` and `destination_refused`, with `detail.reason`
naming the error code only. A `graph` target adds two of its own before the request is made:
`authentication_failed` when Microsoft rejects the client secret or the refresh token, and
`credential_rotation_failed` when a rotated refresh token could not be written back to the
vault. Every injected value, in every encoding, is replaced by
`[redacted:<field>]` before the result leaves the engine. Every method but `GET`, `HEAD` and
`OPTIONS` is a write: the operator may require a human confirmation for it (see below).

### `sql_query` (`actions:sql.read`)

`target` (a name from `actions_list_targets`), `statement` (exactly one SQL statement, at most
64 KiB) and optional `params` (at most 100 strings, numbers, booleans or nulls) in. There is no
interpolation path: every value goes in `params` and is referenced positionally, `$1…$n` on
PostgreSQL and `@p1…@pn` on SQL Server, and a placeholder without a parameter or a parameter
without a placeholder is `invalid_arguments`. The `engine` field `actions_list_targets` reports
for the target says which dialect to write.

Before anything connects, the statement is tokenised in the target's dialect and classified: a
second statement (a `;` outside a string or comment followed by anything but whitespace) is
`policy_denied` with `detail.reason: "statement_count"`, and anything that is not a read is
`policy_denied` with `detail.reason: "statement_class"`. A read starts with `SELECT`, `WITH` or
`EXPLAIN` and contains none of `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `EXEC`, `EXECUTE`,
`CALL`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`, `COPY`, `LOCK`, `SET`,
`USE`, `BACKUP`, `RESTORE`, `SHUTDOWN`, `RECONFIGURE`, `WAITFOR`, `OPENROWSET` or `OPENQUERY`
outside a string, a comment or a quoted identifier, and names no `xp_`/`sp_` identifier.

Out: `columns` (each with the engine's own type name), `rows` (arrays of JSON scalars in column
order, dates as ISO 8601, binary as base64, decimals and 64-bit integers as strings),
`row_count`, `truncated` (rows were dropped at the target's row or output limit) and
`duration_ms`. A decimal string carries the scale its column declares (`"3.50"`, not `"3.5"`); on
SQL Server a value the driver has already rounded past a safe integer is refused with
`connector_fault` and `detail.reason: "exact_numeric_precision"` instead, so cast that column to
`varchar`. On PostgreSQL the session is opened read-only; on SQL Server the classification
and the target's own login are the controls. A database error raised after sign-in is
`upstream_error` with the server's message; a database that could not be reached is
`connection_failed`, `tls_error`, `authentication_failed`, `destination_refused` or `timeout`.

### `sql_execute` (`actions:sql.write`)

The same arguments as `sql_query`, and the same tokenisation and placeholder rules. The
statement must classify as `dml` (`INSERT`, `UPDATE`, `DELETE`, `MERGE`) or, when the target
policy's write classes include it, `ddl` (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`,
`REVOKE`, `DENY`); anything else, a `SELECT` included, is `policy_denied` with
`detail.reason: "statement_class"`. A target whose policy does not allow the `write` operation
refuses with `detail.reason: "operation"`, and a target carrying a statement allowlist refuses a
statement outside it with `detail.reason: "statement_pattern"`.

Every call is a write, so a target with `confirm_writes` asks a human first (see Confirmation
below) and the call runs only once that human ticks the box. The statement runs in its own
transaction, committed when it succeeds and rolled back on any error or timeout.

Out: `rows_affected`; `columns` and `rows` for the rows the statement returned through
`RETURNING` or `OUTPUT`, both empty when it returned none; `truncated`; `duration_ms`.

### `ssh_run` (`actions:ssh`)

`target` (a name from `actions_list_targets`), `command` (at most 16 KiB, no NUL byte, and no
newline or carriage return unless the target is an any-command one) and an optional `stdin` (at
most 64 KiB, written to the command and then closed) in.

The command is matched **whole** against the patterns the operator allowed on the target, before
anything connects: `*` matches any run of characters except a newline, matching is anchored at
both ends and case-sensitive, and a command no pattern matches is `policy_denied` with
`detail.reason: "command"`. A target the operator marked `unrestricted` in
`actions_list_targets` accepts any command. Then one connection is opened to the address the
host resolved to; the host key the server presents must equal the one pinned on the target or
the call is `host_key_mismatch` before any credential is offered, and only the single
authentication method the operator mapped (a private key from the vault, or a password) is
offered. One exec channel runs the command with no pseudo-terminal, no agent forwarding, no X11,
no environment vaultgate sets and no port forwarding, and the connection is closed when the call
ends: there is no session, so nothing survives to the next call.

Out: `exit_code` (an integer, or `null` when the channel closed without one, as after a signal),
`stdout` and `stderr` captured separately and each cut at the target's output limit, `truncated`
and `duration_ms`. A non-zero exit code is a result, not an error; errors are reserved for the
connection: `host_key_mismatch`, `authentication_failed`, `connection_failed`, `timeout` (which
also signals `KILL` to the remote command) and `upstream_error` for a channel the server refused
or broke. Every `ssh_run` is a shell operation, so the operator may require a human confirmation
for every call (see below), and every injected value in every encoding is replaced by
`[redacted:<field>]` before the result, the error detail or the audit row leaves the engine.

### `winrm_run` (`actions:winrm`)

`target` (a name from `actions_list_targets`), `command` (at most 16 KiB, no NUL byte and no
other control character, and no newline or carriage return unless the target is an any-command
one) and an optional `stdin` (at most 64 KiB, written to the command and then closed) in.

The command is matched **whole** against the patterns the operator allowed on the target, before
anything connects, exactly as for `ssh_run`. The target says which shell runs it: a PowerShell
target sends the command as an `-EncodedCommand`, so quoting reaches the host unchanged and no
`cmd.exe` re-parses it; a cmd target sends a `cmd.exe` command line. Then one HTTPS connection is
opened to the address the host resolved to; where the operator pinned the listener's certificate,
a host presenting any other certificate is `tls_error` before the credential is sent. One
WS-Management shell is created for the call and deleted when it ends: there is no session, so
nothing survives to the next call.

Out: `exit_code` (an integer, or `null` when the shell ended without one), `stdout` and `stderr`
captured separately and each cut at the target's output limit, `truncated` and `duration_ms`. A
non-zero exit code is a result, not an error; errors are reserved for the connection:
`tls_error`, `authentication_failed` (a 401 from the listener), `connection_failed`, `timeout`
(which signals `terminate` to the command and then deletes the shell) and `upstream_error` for a
fault the service reported, with its reason scrubbed and capped. Every `winrm_run` is a shell
operation, so the operator may require a human confirmation for every call (see below), and every
injected value in every encoding is replaced by `[redacted:<field>]` before the result, the error
detail or the audit row leaves the engine.

### Connector tools

Every connector tool takes `target` first and resolves it in a fixed order, stopping at the first
failure: layer enabled, target exists, client granted, connector enabled, target enabled, stored
target valid, scope held, arguments valid, policy, rate limits, confirmation, credential, pinned
destination, run. An ungranted client learns nothing about a target beyond `not_granted`. The
result never contains the credential: every injected value, in every encoding, is replaced by
`[redacted:<field>]` in results, error details, audit rows and confirmation prompts. Write, shell
and browser tools carry `destructiveHint: true` and `openWorldHint: true`, so a client may prompt
its user before every call; the server never relies on that prompt.

### Confirmation

When a target's policy sets `confirm_writes` — which the create form turns on for every new
target, whatever the connector — every non-read call needs a human's approval
through MCP form-mode elicitation. On protocol `2026-07-28` the call answers with an
`input_required` result carrying one `elicitation/create` request (a single boolean, "Allow this
call") and an opaque `requestState`; the client shows the prompt, then retries the same call with
`inputResponses.confirm` and the state echoed verbatim, and vaultgate runs it. The state is
signed, expires after two minutes, is single-use and is bound to the client, the token, the
target's revision and the exact arguments; anything else is refused. A client that declares no
form-mode elicitation is refused before anything else happens with the fixed message of
`confirmation_unavailable`. A retry that echoes the state without a well-formed answer is treated
as a fresh call: nothing runs and the prompt is issued again.

**What the prompt shows, and what it admits it does not.** The operation is shown with every one
of its lines prefixed `>`, and the message says so, so a statement or command that reproduces the
prompt's own closing question cannot make the message appear to end before its operative clause:
anything the agent wrote is a quoted line, and the closing question is the only unquoted one. An
operation longer than 1 KiB is shown as its first 768 characters and its last 192 — the tail
matters, because a payload appended to a long prelude is what a head-only cut hides — and the
message then carries an unquoted `NOT SHOWN:` line giving the number of characters missing and
the SHA-256 of the whole operation. Do not approve an operation you have not read: the digest is
there so you can identify what you were asked about.

**A confirmed target needs a client on `2026-07-28`.** A client on an older protocol revision is
always refused `confirmation_unavailable`, whatever it supports and whatever it declared when it
connected, and there is no fallback that could change that. The older wire declares elicitation
once, during `initialize`; vaultgate serves every request with a fresh stateless handler, which
never sees that message and has no open channel on which a server-to-client prompt could be
delivered or answered. Reads on the same target and the same wire are unaffected. If your client
is on the older revision, either use one on `2026-07-28` or set `confirm_writes: false` and
review the target's writes under **Unexpected writes** on the console's Activity page. Spec
[ACT-48](../spec/13-actions.md) records the whole finding.

### Actions error codes

Failures are `{ "error": "<code>", "message": "…", "detail"?: { … } }` with `isError: true`;
every code has one fixed message and `detail` is the only variable part.

| Code                                                                                                                                                 | Meaning                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_target`, `not_granted`, `target_disabled`, `target_invalid`, `connector_disabled`, `actions_disabled`                                       | The target cannot be used by this client on this deployment; `actions_list_targets` shows what can.                                                                                                                           |
| `invalid_arguments`                                                                                                                                  | The arguments do not match the tool schema; `detail.problems` says where.                                                                                                                                                     |
| `policy_denied`                                                                                                                                      | The target policy refused the operation; `detail.reason` is `method`, `path`, `header`, `body_size`, `command`, `command_metacharacter` (a shell operator in a command on a target that is not an any-command one) and so on. |
| `rate_limited`                                                                                                                                       | Per-target or per-client limit; `detail.retry_after_s`.                                                                                                                                                                       |
| `confirmation_unavailable`, `confirmation_declined`, `confirmation_cancelled`, `confirmation_expired`, `confirmation_invalid`, `confirmation_reused` | The confirmation of the section above did not happen, was refused, or the retried state was stale, altered or replayed.                                                                                                       |
| `credential_unavailable`                                                                                                                             | The vault is locked or the item or field is missing; the operator sees why on the target's page.                                                                                                                              |
| `destination_refused`, `connection_failed`, `tls_error`, `host_key_mismatch`, `authentication_failed`, `timeout`, `upstream_error`                   | The destination could not be reached, presented an SSH host key or a TLS certificate other than the pinned one, or answered with an error; `detail` carries a scrubbed, capped message where one exists.                      |
| `connector_fault`                                                                                                                                    | The call failed inside vaultgate rather than at the destination, which may never have been contacted; `detail.reason` says which.                                                                                             |

## Secret-handling rules, in plain words

- **One door.** Only `get_secret` returns a secret value, one field of one item per call, and it
  needs its own scope. Every other tool's result schema has no place to put a secret: item
  summaries carry `has_password`, `has_totp` and `has_notes` flags, never the values; hidden custom
  fields are listed by name with `value: null`.
- **Notes are secrets.** A secure note's body and a login's notes are reachable only through
  `get_secret`, because a secure note is a secret by definition.
- **TOTP: the code, never the seed.** `get_secret` with `totp` returns the current six-digit code
  and how long it remains valid.
- **Card and identity items.** They are listed and summarised like any item, but the number,
  code and identity fields are reachable only through `get_secret`.
- **Writes need not reveal.** `generate_password: true` lets an agent create or rotate a
  credential it never sees. Supplying a password explicitly means the agent is handling secret
  material, so that call needs `vault:reveal` too.
- **Nothing is executed on the vaultgate host.** No vault tool runs a command, reads a file or
  fetches a URL. An agent that wants to use a secret in a command has to reveal it, which is
  audited, and run the command itself. The actions layer above changes this for operator-defined
  targets only, behind its own switches and scopes, and executes only at the target.
- **Audit, not content.** Each tool call is recorded with the client, the token id, the tool, the
  outcome, the item id and (for `get_secret`) the field name, the duration and the source address.
  Arguments and results are never recorded, and the `password` input of the write tools is
  excluded from logs.
- **Errors carry no vault content.** Every error code has one fixed message; the text of a
  `bw serve` rejection is never forwarded.

## Limits

| Limit                | Value                                               |
| -------------------- | --------------------------------------------------- |
| Tool calls per token | 120 per minute; `429` with `Retry-After` beyond it. |
| Search results       | 50 per call; `truncated: true` signals more.        |
| Request body         | 256 KiB; `413` beyond it.                           |
| Access token         | 1 hour by default (`VAULTGATE_ACCESS_TOKEN_TTL`).   |

## Error codes

| Code                    | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `vault_unavailable`     | `bw serve` is not running or not unlocked. Check `/readyz` and the log. |
| `not_found`             | No such item, folder or secret field.                                   |
| `ambiguous`             | A name matched more than one object.                                    |
| `invalid_item`          | The vault rejected a write (validation).                                |
| `vault_protocol_error`  | `bw serve` answered with an unexpected shape; the call failed closed.   |
| `invalid_field`         | `get_secret` was given a field name it does not know.                   |
| `conflicting_arguments` | `password` and `generate_password` were both given.                     |
