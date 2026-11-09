# 15 The credential relay

> **Status: added in 0.1.0-rc.24.** Decided in
> [ADR 0009](../adr/0009-tailnet-credential-relay.md). Off unless `VAULTGATE_RELAY_LISTEN` is set.
> Requirement identifiers are `RELAY-n`.

## 15.1 Purpose and trust

Some programs need a credential's value in their own process: a `psql` wrapper that sets
`PGPASSWORD`, a script that signs in to an API, a test harness that logs in to a staging site.
The actions layer (spec 13) cannot serve them, because it never hands a value out. Such programs
usually run where a full vault client is installed and signed in, which means a master password
on every machine that runs them.

The relay serves those programs on machines that join the operator's [Tailscale](https://tailscale.com)
tailnet as **tagged** nodes, such as short-lived build or agent sandboxes. It answers the read
subset of the `bw serve` Vault Management API, so a client written for a local `bw serve` works
unchanged when pointed at the relay, and it answers only for the items the operator put in its
scope.

The trust an operator extends by enabling the relay is **every in-scope secret, in plaintext, to
any process on any node carrying a listed tag**. Unlike an action or `get_secret`, the value
leaves vaultgate and enters the caller's process memory, and vaultgate cannot see what happens to
it next. The scope (RELAY-4), the tags (RELAY-3) and the audit trail (RELAY-8) are the controls;
the threat model (T51 to T58) states what they do not cover.

## 15.2 Configuration

- **RELAY-1** The relay MUST be off unless `VAULTGATE_RELAY_LISTEN` is set. With it set, start-up
  MUST refuse a configuration without at least one tag in `VAULTGATE_RELAY_TAGS` and at least one
  id in `VAULTGATE_RELAY_COLLECTIONS` or `VAULTGATE_RELAY_ITEMS`, unless
  `VAULTGATE_RELAY_ALL_ITEMS` is true (RELAY-12). Tags MUST have the form
  `tag:name` and ids MUST be UUIDs; both are compared without regard to case.

| Variable                           | Default                              | Meaning                                                                                                                           |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `VAULTGATE_RELAY_LISTEN`           |                                      | `address:port` (IPv6 in brackets) of the relay's own listener, normally the host's tailnet address.                               |
| `VAULTGATE_RELAY_TAGS`             |                                      | Comma-separated Tailscale tags; a caller's node must carry at least one.                                                          |
| `VAULTGATE_RELAY_COLLECTIONS`      |                                      | Comma-separated collection ids; their items are in scope.                                                                         |
| `VAULTGATE_RELAY_ITEMS`            |                                      | Comma-separated item ids in scope whatever their collections.                                                                     |
| `VAULTGATE_RELAY_ALL_ITEMS`        | `false`                              | Puts every live login and secure note in scope, whatever its collections (RELAY-12). The widest setting; start-up logs a warning. |
| `VAULTGATE_RELAY_TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock` | The local Tailscale daemon's LocalAPI socket, which the relay asks who each caller is. An absolute path.                          |
| `VAULTGATE_RELAY_MCP_CLIENT`       |                                      | The OAuth `client_id` whose live consent `/mcp/token` issues access tokens under (RELAY-14). Unset, the route does not exist.     |

## 15.3 Listener and admission

- **RELAY-2** The relay MUST listen on its own listener, bound to the one IP address the operator
  configured; a wildcard address (`0.0.0.0`, `::`) and a host name MUST be refused at start-up.
  None of the OAuth, MCP, console or health routes MAY be served on it, and none of the relay's
  routes on the main listener. A failed bind (the tailnet interface not yet up) MUST be retried
  and MUST NOT end the process. A request whose `Host` header is not the listen address and port
  (or the bare address when the port is 80) MUST be refused.
- **RELAY-3** Every request MUST be admitted before any route runs, in this order: a request
  carrying an `Origin` header is refused; the socket's remote address (never a header such as
  `X-Forwarded-For`, and an IPv4-mapped IPv6 address read as its IPv4 form) is resolved by the
  local Tailscale daemon's LocalAPI `whois`, bounded by a 2 s timeout; an address the daemon does
  not name and a failed or malformed answer are refused; and the node it names MUST carry at
  least one listed tag (so a node a user owns, which has no tags, is always refused), MUST NOT
  route for any address but its own (a subnet router or an exit node: any route among its
  allowed IPs beyond its own addresses, or any primary route), because traffic it forwards
  reaches the relay under its identity, and MUST have the socket address among its own
  addresses. Every refusal is `403` with `{"success":false,"message":"Forbidden."}` and reaches
  neither a route nor the vault.

## 15.4 Scope

- **RELAY-4** An item MUST be answered only when it is a login or a secure note, is not in the
  trash, and either its id is listed in `VAULTGATE_RELAY_ITEMS` or one of its collections is listed
  in `VAULTGATE_RELAY_COLLECTIONS`. Every other item MUST be answered exactly as an item that does
  not exist, on every route, so a caller cannot learn that it exists.

- **RELAY-12** With `VAULTGATE_RELAY_ALL_ITEMS` true, every live login and secure note MUST be in
  scope, whatever its organisation or collections, including items in a personal vault that no
  collection can name. The other rules of RELAY-4 still apply (no trash, no other item types), and
  start-up MUST log a warning naming the setting while the relay listens. It is the widest scope
  the relay offers: every admitted node can read every such secret.

## 15.5 Routes

- **RELAY-5** The relay MUST answer only these routes, each in `bw serve`'s envelope
  (`{"success":true,"data":…}` or `{"success":false,"message":…}`):

  | Route         | Answer                                                                       |
  | ------------- | ---------------------------------------------------------------------------- |
  | `GET /status` | `{"object":"template","template":{…}}` (RELAY-10)                            |
  | `POST /sync`  | `{"object":"message","title":"Syncing complete.","message":null}` (RELAY-13) |

| `POST /mcp/token` | `{"object":"token","access_token":…}`, only when configured (RELAY-14) |
| `GET /list/object/items?search=<term>` | `{"object":"list","data":[<item>…]}` (RELAY-6) |
| `GET /object/item/<id or term>` | `<item>` (RELAY-7) |
| `GET /object/{username,password,notes,totp,uri}/<id or term>` | `{"object":"string","data":<value>}`; the empty string when the item holds none |

Any other path or method, `/unlock`, `/lock`, writes, `/generate` and the folder and collection
lists included, MUST be answered `404` with `{"success":false,"message":"Unknown route."}`.

- **RELAY-6** A term that is a UUID MUST read that item; any other term MUST be the vault's own
  search (name, username, URI) filtered to the scope. One match is the answer. Several matches of
  which exactly one has the term as its name, ignoring case and surrounding space, answer that
  one; otherwise the answer is `400` with `bw serve`'s own message, beginning
  `More than one result was found.` and listing the ids. No match is `404` `Not found.` A term
  MUST be non-blank and at most 200 characters (`400` otherwise). The list route MUST require a
  term and MUST refuse with `400` a search matching more than 20 in-scope items.
- **RELAY-7** An item MUST be answered as `bw serve` answers it for the fields vaultgate models
  (spec 05): `object`, `id`, `organizationId`, `folderId`, `type` (1 login, 2 secure note),
  `name`, `notes`, `favorite`, `fields` (each with `name`, `value`, `type` 0 to 3 and `linkedId`),
  `login` (`uris`, `username`, `password`, `totp`) or `secureNote`, `collectionIds`,
  `revisionDate`. `login.totp` MUST always be `null`: a TOTP seed never leaves vaultgate, and the
  current code is answered on the `totp` route only.
- **RELAY-13** `POST /sync` MUST ask for the operator's own sync (VAULT-19), which joins a sync
  already running, and MUST answer only once that sync has finished: `Syncing complete.` when it
  succeeded, otherwise as RELAY-10 (`503` while the vault is unavailable, `500` for any other
  failure). Relay callers together MUST start at most one sync every 10 seconds: a request within
  10 s of the start of the last sync a relay request started MUST answer with that sync's outcome
  instead of starting another, whichever node asks, and its `relay.sync` event records
  `shared: true`. A node can so pick up a change made outside vaultgate at once, instead of
  waiting up to `VAULTGATE_BW_SYNC_INTERVAL` for the next scheduled sync (VAULT-9), but cannot
  make vaultgate ask the vault server more often than once every 10 s.

## 15.5a Access tokens for `/mcp`

An agent sandbox that joins the tailnet can speak to `/mcp` itself, instead of through a client
that holds an OAuth grant on its behalf. Such sandboxes are many, short-lived and concurrent, so
none of them can hold a refresh token: a refresh token rotates on every use, and a reused one
revokes its whole family (OAUTH-25). The relay is the one holder instead, and it never needs a
refresh token at all, because it mints each access token directly under a consent the operator
already gave.

- **RELAY-14** With `VAULTGATE_RELAY_MCP_CLIENT` set, `POST /mcp/token` MUST issue an admitted
  caller (RELAY-3) one access token exactly as the token endpoint issues one (OAUTH-24: `vg_at_`,
  stored as its SHA-256 only, the configured access-token lifetime, bound to this deployment's
  canonical resource), recorded against that client and that client's newest live consent, with
  every scope in the registry (§03.8, §13.5), so the whole tool surface is reachable and a tool
  added in a later release needs no new consent, and with no refresh token. The answer is
  `{"object":"token","access_token":…,"token_type":"Bearer","expires_in":…,"scope":…,"resource":…}`
  in the relay's envelope. Without the setting the route MUST be an unknown route (RELAY-5). The
  value MUST be at most 512 characters with no whitespace; start-up MUST refuse it otherwise.
- **RELAY-15** A relay token MUST NOT bypass the operator's controls: `/mcp` verifies it as any
  other access token (OAUTH-32), its scopes are intersected with the scopes the deployment
  enables at use as every token's are (so `VAULTGATE_ENABLE_WRITE_SCOPE` and the connector
  switches still decide), and every action stays bound by that client's target grants, read-only
  ceilings and target policy (ACT-9). When the client is unknown or revoked, or
  has no live consent, the route MUST answer `503` `No consent to issue under.` and issue nothing.
  Revoking the consent (OAUTH-30) MUST make every relay token issued under it fail verification,
  as it does every other token of that consent; `/oauth/revoke` revokes one.
- **RELAY-16** Every issue MUST be audited twice: `relay.mcp_token` in category `relay` with the
  node name and address, the client id and the token's 12-character prefix (or the refusal), and
  `token_issued` in category `oauth` with the same client, prefix and node, so a call on `/mcp`
  (MCP-13) traces back to the node the token was issued to. No event MAY carry the token.

## 15.6 Audit, limits and failures

- **RELAY-8** Every request MUST be audited in category `relay`: `relay.denied` for every refusal
  of 15.3 with its reason, and `relay.status`, `relay.sync`, `relay.list`, `relay.item` or
  `relay.secret` for every routed request, each with the caller's node name and address, and
  for item reads the item id and, for scalars, the field. The list route records one event per
  item it answers. A lookup that finds nothing or several items records the term. No event MAY
  carry a secret value.
- **RELAY-9** Each node MUST be limited to 300 requests per minute (a token bucket); a request over
  the limit MUST be answered `429` with `Retry-After` and recorded as `relay.denied`.
- **RELAY-10** `/status` MUST report the vault's lock state (`unlocked`, `locked` or
  `unauthenticated`) and its last sync, with `serverUrl` and `userEmail` always `null`. A vault
  that is unavailable MUST be answered `503` `Vault is unavailable.`, so a client retries; any
  other vault failure is `500` `Vault error.` An item or list answer MUST fail whole if any one
  of its secrets cannot be read: no partial item is ever answered.
- **RELAY-11** `src/relay/` MUST read the vault through the `VaultClient` interface only, with
  every secret read through `getSecret`, ask for a sync only through the function the
  composition layer passes it (RELAY-13), and issue an `/mcp` access token only through the
  function the composition layer passes it (RELAY-14); it MUST NOT import `src/bitwarden/`, `src/storage/` or
  another feature, and no feature but the composition layer MAY import it.

## 15.7 Non-goals

- No writes, no unlock and no vault administration on the relay, ever.
- No authentication other than the tailnet identity: there is no relay token to leak, and no
  OAuth on this listener. `/mcp/token` (RELAY-14) hands out access tokens for the main listener;
  it is not an OAuth endpoint, and it never issues or accepts a refresh token.
- No TOTP seeds, attachments, password history, cards, identities or SSH key items.
- No access over Tailscale Funnel or any public address: the relay is for tailnet peers.
