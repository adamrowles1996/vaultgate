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
widened, so a client connected earlier must be disconnected on the account page and connected
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

## Actions (planned)

A future, off-by-default layer lets an agent _use_ a credential without receiving it: the
operator defines a target (an API, a database, a server, a Windows host or a website plus the
vault item that signs in to it, an allowlist policy and the clients allowed to use it), and the
agent calls `http_request`, `sql_query`, `sql_execute`, `ssh_run`, `winrm_run` or the
`browser_*` tools by target name. Each connector has its own `actions:*` scope, marked risky at
consent; write and shell calls carry MCP `destructiveHint` annotations and can require a per-call
confirmation through MCP elicitation; every injected value is scrubbed from every result. The
engine core (targets, grants, policy, confirmation, scrubbing, limits and audit, behind
`VAULTGATE_ENABLE_ACTIONS`) landed with M9's first pull request, but no tool or page exists yet,
so nothing changes for an agent or an operator until they do: see
[13 Actions](../spec/13-actions.md),
[14 Action connectors](../spec/14-actions-connectors.md) and
[ADR 0007](../adr/0007-typed-actions-with-operator-policy.md); milestones M9 to M15 in
[`PLAN.md`](../PLAN.md).

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
- **Nothing is executed.** There is no tool that runs a command, reads a file or fetches a URL.
  An agent that wants to use a secret in a command has to reveal it, which is audited, and run
  the command itself. (The planned actions layer above will change this for operator-defined
  targets only, behind its own switches and scopes.)
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
