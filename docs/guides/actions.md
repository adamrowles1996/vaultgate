# Actions: let an agent use a credential it never sees

The actions layer (specification [13 Actions](../spec/13-actions.md) and
[14 Action connectors](../spec/14-actions-connectors.md), decided in
[ADR 0007](../adr/0007-typed-actions-with-operator-policy.md)) lets an agent _use_ a vault
credential without receiving it. You define a **target**: where the agent may go, which vault
item signs in there, what it may do, and which clients may use it. The agent names the target
and describes an operation; vaultgate fetches the credential, performs the operation inside your
policy, scrubs the result of every injected value and returns it.

This guide is for the operator. It covers what exists today: the layer's switches, the account
page that manages targets, the `http` and `sql` connectors' target forms, and what an agent does
with those targets through `http_request` and `sql_query`. The other connectors (`ssh`, `winrm`,
`browser`) land with their milestones; until then their targets cannot be created.

## Enabling the layer

The layer is off unless the deployment says otherwise, and each connector has its own switch:

```bash
VAULTGATE_ENABLE_ACTIONS=true
VAULTGATE_ACTIONS_ENABLE_HTTP=true
VAULTGATE_ACTIONS_ENABLE_SQL=true
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

| Mode     | What is sent                                                                              | Fields                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bearer` | `Authorization: Bearer <value>`                                                           | the secret field                                                                                                                                                               |
| `basic`  | `Authorization: Basic base64(username:value)`                                             | the secret field; the username field (`login.username` unless said otherwise)                                                                                                  |
| `header` | `<name>: <prefix><value>`                                                                 | the secret field, the header name, an optional prefix                                                                                                                          |
| `query`  | `<name>=<url-encoded value>` appended to the query string, after the agent's own query    | the secret field, the parameter name, an optional prefix; the policy must allow query credentials                                                                              |
| `graph`  | A Microsoft Graph access token obtained server-side (client credentials or refresh token) | tenant id, application id, grant, scope, the client secret field and, for the refresh grant, the refresh token field (see [Microsoft Graph targets](#microsoft-graph-targets)) |

A secret field is a `get_secret` selector: `password`, `totp`, `notes`, `custom.<name>` for a
hidden custom field, `card.number`, `card.code`, `identity.<field>` or `sshKey.privateKey`. Saving
checks that the item exists and carries every mapped field (through the vault's metadata; no
secret is read), and the target's page then shows the item's name beside its id.

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

## Microsoft Graph targets

The `graph` credential mode makes vaultgate obtain the Microsoft Graph access token itself, so
the agent never sees the client secret, the refresh token or the access token — it only ever
calls `http_request` on a target whose `base_url` is `https://graph.microsoft.com` (a path
prefix such as `/v1.0` is allowed, and then every `path` the agent gives is relative to it).

**In Entra ID.** Register an application, note its **Directory (tenant) ID** and **Application
(client) ID**, and create a client secret. Then choose the grant:

- **Client credentials** — the application acts as itself. Give it _application_ permissions
  (for example `User.Read.All`) and grant admin consent. The scope stays
  `https://graph.microsoft.com/.default`, which means "every application permission this app has
  consented to"; Microsoft rejects any other scope for this grant.
- **Refresh token** — the application acts as one signed-in user. Give it the _delegated_
  permissions you need, add `offline_access`, and obtain a refresh token once through an
  interactive sign-in of that user (the authorization-code flow, outside vaultgate). The scope is
  then the delegated scopes you want on each token, space separated, for example
  `https://graph.microsoft.com/User.Read offline_access`.

**In the vault.** Put the client secret in a field of one item — a hidden custom field is the
natural home — and, for the refresh-token grant, put the refresh token in a second hidden custom
field of the same item. Map them as **Graph client secret field** (`custom.<name>`) and **Graph
refresh token field**.

**What happens on a call.** Before the request, vaultgate posts the grant to
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` through the same pinned transport
the request uses: the host is resolved and checked against the private-range rule like any other
destination. The access token is held in process memory only, keyed by the target and its
revision, until sixty seconds before it expires; it is never stored and never logged, and it is
redacted from every result as `[redacted:graph.access_token]`. Editing the target retires the
cached token. A `401` from Graph discards it and the request is retried once with a fresh one; a
second `401` is returned as the result, like any other status.

**Rotation.** Microsoft rotates refresh tokens: when the token endpoint returns a new one,
vaultgate writes it back into the mapped vault field **before** it makes the Graph request and
records an `actions.credential_rotated` event naming the target, the item and the field (never
the value). If that write-back fails the call fails with `credential_rotation_failed` rather
than proceeding, so you learn while the old token still works — check that the vault is unlocked
and that the mapped field is one vaultgate can write (a custom field, the login password or the
notes).

**Errors.** `authentication_failed` means the token endpoint rejected the credential
(`invalid_client`: the secret is wrong or expired; `invalid_grant`: the refresh token is spent,
revoked or for another tenant); the OAuth error code is in `detail.error` and the call history
carries it too. Any other answer from the token endpoint is `upstream_error` with its status.

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

## Creating a `sql` target

Follow **Create a sql target**. The four parts are the same shape as an `http` target's.

**Destination.** The `engine` (`postgres` or `mssql`), the `host`, the `port` (5432 and 1433 by
default), the `database`, and **Transport security**:

| `tls`         | What happens                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `require`     | The connection is encrypted and the certificate is verified against the system store. The default.      |
| `verify-full` | The same, but verified against the PEM you paste into **Certificate authority**, for a private CA.      |
| `disable`     | Plain, unencrypted transport. Allowed only on an **internal** target, and never a good idea over a WAN. |

There is no "trust the server certificate" option: a self-signed or private-CA certificate is
handled by `verify-full` with its PEM, not by turning verification off. Saving resolves the host
and checks every address against the private-range rule; it does not connect.

**Credential mapping.** The vault item id, the field holding the **login name**
(`login.username` by default) and the field holding the **password** (`password` by default).
Both are `get_secret` selectors, so a hidden custom field (`custom.<name>`) works for either.

**Policy.** `operations` (`read` today; `write` needs `sql_execute`, which arrives with M11's
second pull request, and a target that asks for it is refused at save until then), **maximum
rows** (default 500, at most 10 000), the **statement timeout** (the server cancels a statement
that runs longer; defaults to the call timeout), and the common timeout, output and rate limits.
`write_classes`, `statement_allowlist` and `schemas` are read by `sql_execute` only and have no
effect on `sql_query`.

### The dedicated login

Every `sql` target should have its own login with the least privilege the work needs. The
classification below is a control in depth; **the login is the control**.

PostgreSQL, a read-only role over one schema:

```sql
CREATE ROLE vaultgate_reader LOGIN PASSWORD 'put-a-generated-password-here';
GRANT CONNECT ON DATABASE reporting TO vaultgate_reader;
GRANT USAGE ON SCHEMA public TO vaultgate_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vaultgate_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO vaultgate_reader;
ALTER ROLE vaultgate_reader SET default_transaction_read_only = on;
```

SQL Server, a read-only login and user:

```sql
CREATE LOGIN vaultgate_reader WITH PASSWORD = 'put-a-generated-password-here';
USE reporting;
CREATE USER vaultgate_reader FOR LOGIN vaultgate_reader;
ALTER ROLE db_datareader ADD MEMBER vaultgate_reader;
DENY EXECUTE TO vaultgate_reader;
```

Store the password in a vault item and point the target's credential mapping at it. Rotating it
in the vault is enough: vaultgate opens one connection per call and holds no pool, so the next
call uses the new password.

## Calling a `sql` target

An agent whose token holds `actions:sql.read` and whose client you granted the target calls
`sql_query`:

```json
{
  "target": "warehouse",
  "statement": "SELECT id, total FROM orders WHERE placed_at > $1 ORDER BY placed_at LIMIT 50",
  "params": ["2026-09-01"]
}
```

What vaultgate does with it, in order:

1. **Classification first, no connection.** The statement is tokenised in the target's dialect —
   string literals (`'…'` with doubled quotes, `N'…'` on SQL Server, `E'…'` and `$tag$…$tag$` on
   PostgreSQL), quoted identifiers (`"…"`, and `[…]` on SQL Server), line comments and block
   comments (which nest on PostgreSQL) — and must be **exactly one statement**: a `;` outside a
   string or comment followed by anything but whitespace, a trailing comment included, is
   `policy_denied` with `detail.reason: "statement_count"`. It must then classify as `read`:
   the first keyword is `SELECT`, `WITH` or `EXPLAIN`, no writing, executing or session-changing
   keyword appears outside a string, comment or quoted identifier, and no identifier begins with
   `xp_` or `sp_`. Anything else is `policy_denied` with `detail.reason: "statement_class"`, and
   the class it was given (`dml`, `ddl`, `other`) is recorded in the call history.
2. **What classification is and is not.** It is a cheap, conservative filter that stops the
   obvious: a second statement smuggled past a comment, a `DELETE` hidden in a CTE, `xp_cmdshell`.
   It is **not** a SQL parser and does not promise to understand every dialect: `SELECT … INTO`,
   `EXPLAIN ANALYZE DELETE …` and anything it cannot read confidently are refused rather than
   allowed, and a statement it does allow can still do whatever the login may do. Give the target
   a read-only login.
3. **Parameters.** Placeholders are counted in the tokenised statement, outside strings and
   comments: `$1…$n` on PostgreSQL, `@p1…@pn` on SQL Server. A placeholder with no parameter, a
   parameter with no placeholder, or a gap in the sequence is `invalid_arguments`. There is no
   other way to get a value into a statement.
4. **The credential and one pinned connection.** The login name and password are fetched from
   the vault after the policy decision, the host is resolved once and every address checked
   against the private-range rule, and one connection is opened to that address with the host
   name kept for TLS (SNI and certificate verification). There is no pool: the connection is
   closed when the call ends. On PostgreSQL the session sets `default_transaction_read_only` and
   the statement runs inside `BEGIN READ ONLY`; SQL Server has no equivalent, so there the
   classification and the login are the whole of it.
5. **The result.** `columns` (name and the engine's own type name), `rows` (arrays of JSON
   scalars in column order: dates as ISO 8601, binary as base64, decimals and 64-bit integers as
   strings), `row_count`, `truncated` and `duration_ms`. Rows are dropped whole at **maximum
   rows** and at **maximum output**, never cut in half, and every injected value in every
   encoding is replaced by `[redacted:<field>]` before the result leaves the engine. Note that
   SQL Server's driver parses `decimal`, `numeric` and `money` as JavaScript numbers before
   vaultgate can see them, so a value with more than about fifteen significant digits is already
   rounded when it is rendered as a string; cast such a column to `varchar` in the statement if
   you need every digit.

A SQL error raised after sign-in — a bad column name, a permission denied — is `upstream_error`
with the server's message (scrubbed, capped at 1 KiB). A login the server rejects is
`authentication_failed`, an unreachable or refused server is `connection_failed`, a certificate
that does not verify is `tls_error`, and a statement the server cancels at the statement timeout
is `timeout`.

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
