# 06 MCP surface

## 6.1 Transport

- **MCP-1** Streamable HTTP at `POST /mcp` using `@modelcontextprotocol/server` v2 via
  `@modelcontextprotocol/node`. The handler is stateless: a fresh `McpServer` is built per request
  from the verified `AuthInfo`, so horizontal scaling needs no shared session state.
- **MCP-2** The server advertises protocol version `2026-07-28` and accepts the versions the SDK
  supports for backwards compatibility.
- **MCP-3** `Origin` validation: when a request carries an `Origin` header it must be
  `VAULTGATE_PUBLIC_URL`'s origin or an entry in `VAULTGATE_ALLOWED_ORIGINS`, otherwise `403`
  (DNS-rebinding defence). `Host` must match the public URL host unless `VAULTGATE_TRUST_PROXY`
  is set and `X-Forwarded-Host` matches.
- **MCP-4** Request bodies are capped at 256 KiB; larger bodies get `413`.
- **MCP-5** Per-token rate limit: 120 tool calls per minute, `429` with `Retry-After` beyond it.

## 6.2 Tools

All tools declare `inputSchema` and `outputSchema` with zod; every result also carries a
human-readable `content` text. Names are stable API.

| Tool                  | Scope            | Purpose                                                                                                                                                                                               |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault_status`        | `vault:read`     | Server URL, account e-mail (masked), lock state, last sync time, item count.                                                                                                                          |
| `search_items`        | `vault:read`     | Full-text search with optional `type`, `folder_id`, `collection_id`, `url`, `include_trash`; hard cap 50 results; returns id, name, type, username, URIs, folder, favourite, revision date.           |
| `get_item`            | `vault:read`     | One item's metadata. Secret fields are reported as `{ present: true }`, never their value.                                                                                                            |
| `list_folders`        | `vault:read`     | Folder ids and names.                                                                                                                                                                                 |
| `list_collections`    | `vault:read`     | Collection ids, names and organisation ids.                                                                                                                                                           |
| `get_secret`          | `vault:reveal`   | The value of exactly one secret field: `password`, `totp` (current code + seconds remaining), `notes`, `card.number`, `card.code`, `identity.*`, `sshKey.privateKey`, or a named hidden custom field. |
| `generate_password`   | `vault:generate` | Random password with length and character-class options; nothing is stored.                                                                                                                           |
| `generate_passphrase` | `vault:generate` | Diceware-style passphrase with word count and separator options.                                                                                                                                      |
| `create_item`         | `vault:write`    | Create a login or secure note. Accepts an optional `generate_password: true` to have vaultgate fill the password without the agent ever seeing it.                                                    |
| `update_item`         | `vault:write`    | Partial update of name, username, URIs, notes, folder, favourite; `password` only via `generate_password: true` or explicit value with `vault:reveal` also held.                                      |
| `trash_item`          | `vault:write`    | Soft delete (moves to trash). There is no permanent delete tool.                                                                                                                                      |
| `create_folder`       | `vault:write`    | Create a folder.                                                                                                                                                                                      |

The actions tools (`actions_list_targets` and the connector tools) live in section 13 (13.6) and
join this surface only on a deployment that enables the layer, for tokens with an `actions:*` scope.

- **MCP-6** Tool descriptions are written for an LLM audience: they state what the tool returns,
  what it never returns, and when to prefer another tool (for example, "use `search_items` first;
  `get_secret` requires an item id").
- **MCP-7** `tools/list` returns only the tools the token's scopes allow, so an agent is never
  shown a tool it cannot call. Calling a tool outside scope anyway returns the OAUTH-33 challenge.
- **MCP-8** There are no MCP resources or prompts in v1; the capability advertisement says so.
- **MCP-16** The handshake's `instructions` depend on the token. A token that holds an
  `actions:*` scope on a deployment with the actions layer enabled is told to call
  `actions_list_targets` and then the action tool for a target, and to prefer an action to
  `get_secret` so that no secret it only needs to use enters the conversation. Any other token is
  told that read tools return metadata only and that `get_secret` is the sole, audited way to read
  a secret value.

## 6.3 Secret-handling rules

- **MCP-9** Only `get_secret` returns secret values. Every other tool's `outputSchema` is
  structurally incapable of carrying them (no free-form pass-through of vault objects), and
  contract tests assert that a fixture item full of canary strings yields no canary in any
  non-`get_secret` result.
- **MCP-10** Tool inputs that may contain a secret (`update_item.password`) are marked and
  excluded from logs and audit payloads.
- **MCP-11** `get_secret` for `totp` returns the current code and its remaining validity, never the
  TOTP seed.
- **MCP-12** Item `notes` count as secret (secure notes are secrets by definition), so notes are
  reachable only through `get_secret`.

## 6.4 Audit

- **MCP-13** Every tool call appends one audit event: timestamp, client id, client name, operator
  id, token id (first 12 hex of the hash), tool, outcome (`ok` | `denied` | `error:<code>`),
  item id if any, field name for `get_secret`, duration in ms, request id, source IP. Never the
  arguments or results.
- **MCP-14** Authorization events are audited too: login success/failure, consent granted/denied,
  token issued/refreshed/revoked, client registered, recovery code used, bootstrap consumed.
- **MCP-15** Audit rows are append-only from the application's point of view (no update/delete
  path in code) and retained for `VAULTGATE_AUDIT_RETENTION_DAYS` (default 365).
