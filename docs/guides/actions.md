# Actions: let an agent use a credential it never sees

The actions layer (specification [13 Actions](../spec/13-actions.md) and
[14 Action connectors](../spec/14-actions-connectors.md), decided in
[ADR 0007](../adr/0007-typed-actions-with-operator-policy.md)) lets an agent _use_ a vault
credential without receiving it. You define a **target**: where the agent may go, which vault
item signs in there, what it may do, and which clients may use it. The agent names the target
and describes an operation; vaultgate fetches the credential, performs the operation inside your
policy, scrubs the result of every injected value and returns it.

This guide is for the operator. It covers what exists today: the layer's switches, the account
page that manages targets, the `http` connector's target form, and what an agent does with an
`http` target through `http_request`. The other connectors (`sql`, `ssh`, `winrm`, `browser`)
land with their milestones; until then their targets cannot be created.

## Enabling the layer

The layer is off unless the deployment says otherwise, and each connector has its own switch:

```bash
VAULTGATE_ENABLE_ACTIONS=true
VAULTGATE_ACTIONS_ENABLE_HTTP=true
```

Restart after changing them. With the master switch off nothing changes: no `actions:*` scope
is advertised, no tool is listed and the account page has no Actions section. A connector switch
set without the master switch is a start-up warning. Every variable is in
[08 Configuration](../spec/08-configuration.md).

## The Actions section

Sign in and open the account page. Below the vault connection, **Actions** lists every target
with its connector, destination (host and base path only), whether it is enabled, the clients
granted it, its last call and outcome, and the open sessions it holds, with a link to the page
that manages it and a link to create a target per connector this build supports.

Every change (create, edit, enable, disable, delete, grant, remove a grant, close sessions) needs
a fresh password confirmation under **Sensitive actions**; the confirmation lasts five minutes,
as for every other sensitive action. Until then the pages show the target but offer no form.

A target whose stored documents no longer pass validation (for example after an upgrade that
tightened a rule) is marked `target_invalid` with the reason, refuses every call, and can be
repaired or deleted from its page.

## Creating an `http` target

Follow **Create an http target**. The form has four parts.

**The target itself.** A `name` (lower-case letters, digits and hyphens; this is how agents name
it, and renaming is a new target), a `description` written for the agent (what the destination
is and what to use it for), and **Internal destination** when the base URL resolves to a private
address (RFC 1918, CGNAT, unique-local). Loopback and link-local addresses are refused whatever
this says: `bw serve` listens on loopback.

**Destination.** The `base_url`: an `https://` origin with an optional path prefix, no query
string or fragment (`http://` only on an internal target). Every request path the agent gives is
appended to it and must stay under it after normalisation. Saving resolves the host and checks
every address against the private-range rule; it does not connect.

**Credential mapping.** The **vault item id** (find it with `search_items` or in the Bitwarden
web vault's URL) and how the secret is injected:

| Mode     | What is sent                                                                              | Fields                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bearer` | `Authorization: Bearer <value>`                                                           | the secret field                                                                                                                                             |
| `basic`  | `Authorization: Basic base64(username:value)`                                             | the secret field; the username field (`login.username` unless said otherwise)                                                                                |
| `header` | `<name>: <prefix><value>`                                                                 | the secret field, the header name, an optional prefix                                                                                                        |
| `query`  | `<name>=<url-encoded value>` appended to the query string, after the agent's own query    | the secret field, the parameter name, an optional prefix; the policy must allow query credentials                                                            |
| `graph`  | A Microsoft Graph access token obtained server-side (client credentials or refresh token) | tenant id, application id, grant, scope, the client secret field and, for the refresh grant, the refresh token field; **not yet: refused at save until M10** |

A secret field is a `get_secret` selector: `password`, `totp`, `notes`, `custom.<name>` for a
hidden custom field, `card.number`, `card.code`, `identity.<field>` or `sshKey.privateKey`. Saving
checks that the item exists and carries every mapped field (through the vault's metadata; no
secret is read), and the target's page then shows the item's name beside its id. The `graph`
fields are validated now, but a `graph` target is refused at save (and marked invalid on read)
until the adapter lands with M10, so nothing half-implemented can run.

Nothing in these forms is a secret: the row holds the item id and field _names_. The vault
stays the only secret store.

**Policy.** The allowlists and limits:

- **Allowed methods**: `GET` and `HEAD` by default. Anything else is a non-read call.
- **Allowed paths**: one pattern per line, matched against the path and query relative to the
  base URL after normalisation. `*` matches within one segment, `**` across segments; every other
  character is literal and matching is anchored at both ends, so `/v1/users/*` allows one level
  under `/v1/users/` and `/**` allows the whole API. A pattern must start with `/`, must not
  climb above the base URL and must be written in normalised form (the form tells you how).
- **Allowed request headers** and **returned response headers**, one name per line. Whatever
  the list says, an agent can never set `Authorization`, `Cookie`, `Host`, `Content-Length`,
  `User-Agent`, `Transfer-Encoding`, a `Proxy-*` header or the header the credential mapping
  injects. The defaults (`accept`, `content-type`, `if-none-match` in; `content-type`,
  `content-length`, `location`, `retry-after` out) suit most JSON APIs.
- **Maximum request body**, **follow redirects** (off by default; at most two hops, each kept
  under the base URL, see below) and **allow the credential in the query string** (needed by the
  `query` mode; query strings reach proxy and server logs, so prefer a header mode).
- The common limits every connector shares: **timeout** (default 30 s, at most 300 s),
  **maximum output** (default 256 KiB, at most 1 MiB; longer output is truncated) and **calls per
  minute** (default 60, at most 600).
- **Ask a human to confirm every non-read call**: on for every new target. A non-read call then
  asks the client for a confirmation through MCP elicitation before the credential is fetched; a
  client that cannot elicit is refused such calls. Untick it only for a target whose writes you
  are content to delegate to whichever client holds a grant.

A rejected save comes back with every problem listed and the values you typed.

## Calling an `http` target

An agent whose token holds `actions:http` and whose client you granted the target calls
`http_request` with the target's `name`, a `method`, a `path` and optionally `headers` and a
`body`:

```json
{
  "target": "billing-api",
  "method": "POST",
  "path": "/v1/invoices?dry_run=true",
  "headers": { "Accept": "application/json" },
  "body": { "customer": "c_123", "amount": 1200 }
}
```

What vaultgate does with it, in order:

1. **Policy first, no I/O.** The method must be in **Allowed methods**; the path plus query,
   normalised (percent-decoded unreserved characters, dot segments removed), must match one of
   **Allowed paths** and stay under the base URL; every header name must be on the allowlist
   and none of the forbidden ones; the body (a string, or a JSON object or array serialised as
   `application/json` unless the agent set a content type) must fit **Maximum request body**.
   A refusal is `policy_denied` with `detail.reason` (`method`, `path`, `header`, `body_size`)
   and is audited as such. A malformed argument (a path with `..` or an empty segment `//`, a
   header name that is not a token, more than 32 headers) is `invalid_arguments`. The URL that
   is actually built is checked against the base URL as well, so a protocol-relative path can
   never move the request to another host.
2. **Read or write.** `GET`, `HEAD` and `OPTIONS` are read calls; every other method is a
   non-read call and, on a target that asks a human to confirm, waits for the confirmation
   before the credential is fetched.
3. **The credential, from the vault, for this call only.** Fetched after the policy decision
   and the confirmation, placed in its injection point and zeroed when the call ends.
4. **One pinned connection.** The base URL's host is resolved once, every address checked
   against the private-range rule, and the request goes to that address with the host name kept
   for TLS (SNI and certificate verification against the system store; there is no way to skip
   it, a failure is `tls_error`) and `Host`. An **internal** target with an `http://` base URL is
   reached in plain HTTP, to the pinned address, the same way. Every request carries
   `User-Agent: vaultgate/<version>`.
5. **Redirects.** Off by default: a `3xx` comes back as the result with its `location` (when
   the policy returns that header). With **follow redirects** on, at most two hops are followed
   and only while they stay under the base URL (same origin and path prefix), which means the
   same pinned address; the credential is sent again on such a hop. A hop that would leave the
   base URL, or a third hop, is returned as it is. `301`, `302` and `303` turn a `POST` into a
   `GET` without the body; `307` and `308` keep method and body.
6. **The result.** `status`; the response `headers` the policy returns, lower-cased; the `body`
   as text when its media type is textual (`text/*`, JSON, XML, JavaScript, form-encoded, or
   none) and it is valid UTF-8, otherwise base64 with `body_encoding: "base64"`; `bytes`
   received; `truncated` when the body was cut at **Maximum output** (with a guard band, so a
   credential straddling the cut is still scrubbed); `duration_ms`. Every injected value, in
   every encoding, is replaced by `[redacted:<field>]` in the body, the headers and the audit
   row before anything leaves the engine.

A non-2xx status is a normal result: a `401` or `403` means the destination refused the
request and is reported as such, never as `authentication_failed`, so the agent (and you, in
the call history) see what the API said. Only a destination that could not be reached is an
error: `connection_failed` (refused, reset, unresolvable), `tls_error` (certificate or
handshake), `timeout` (the policy timeout elapsed and the request was aborted) or
`destination_refused` (the host resolved to an address the private-range rule refuses), each
with `detail.reason` naming the error code and never an address.

**When to use the `query` mode.** Only for an API that accepts a key nowhere else. The value
travels in the URL, which proxies and servers log; vaultgate sends it URL-encoded after the
agent's own query and scrubs that encoding from every result, but the destination's logs are
outside its control. Prefer `bearer`, `basic` or `header`, and tick **allow the credential in
the query string** only on the target that needs it.

**When to set `internal`.** Only for a base URL that resolves to a private address (an intranet
API). It is the only way to use an `http://` base URL, and it never allows loopback or
link-local: `bw serve` listens on loopback, and an `http` target reaching it would turn a token
into the whole vault.

## Grants

A target is usable by an OAuth client only while you have granted it, and only while that
client's consent stands. On the target's page, **Grants** lists the granted clients and lets you
grant among the clients currently connected (those on the account page's connected-clients
list) or remove a grant, which also closes that client's sessions on the target. Disconnecting a
client on the account page removes every grant it holds, so a reconnected client starts with
none. A grant never widens a token: the client still needs the connector's scope
(`actions:http`) at consent.

## Sessions, calls and the audit trail

The target's page shows its open sessions (browser sessions, a later milestone) with a **Close
sessions** button, and the last 50 calls with their time, tool, operation, classification,
outcome, elicitation result, output size and client. Results are never stored; the arguments
are, scrubbed, so an unexpected write can be read back.

Every change to a target records an `actions.*` audit event with the target name, the
connector, your operator id and, for an edit, the names of the fields that changed (the
credential document counts as one field, `credential`). The **Audit log** section of the account
page exports either the audit events or the action calls for a date range, as JSON Lines or CSV;
the CLI does the same with `node dist/cli.js audit export --stream actions`.

## What the agent sees

An agent with an `actions:*` scope calls `actions_list_targets` and sees, for each granted and
enabled target of an enabled connector whose runtime is loaded, its name, your description, the
connector, the operations its policy and the token's scopes allow, and whether non-read calls
require a confirmation. It never sees the destination, a vault item id, a credential field name
or a policy pattern, and no tool ever returns an injected value: every result, error and audit
row is scrubbed of the value and its encoded forms before it leaves the engine.

## If something is wrong

| Symptom                                         | Where to look                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The section is missing                          | `VAULTGATE_ENABLE_ACTIONS` is not `true`; the start-up log line `configuration loaded` shows the value.                                                     |
| A target is marked `target_invalid`             | Its page lists the validation problem; edit and save, or delete it.                                                                                         |
| Saving says the item has no such field          | The mapping names a field the item does not carry; check the item with `get_item`.                                                                          |
| Saving refuses the destination                  | The host resolves to a private address without **Internal destination**, or to loopback or link-local.                                                      |
| A call fails `credential_unavailable`           | The vault is locked or the item or field is gone; the target's page shows the item's state.                                                                 |
| A call fails `tls_error` or `connection_failed` | `detail.reason` names the error code (`CERT_HAS_EXPIRED`, `ECONNREFUSED`, …); check the destination's certificate and reachability from the vaultgate host. |
| A call fails `policy_denied`                    | `detail.reason` says which allowlist refused it; the call history shows the arguments.                                                                      |
