# Actions: let an agent use a credential it never sees

The actions layer (specification [13 Actions](../spec/13-actions.md),
[13a Actions in operation](../spec/13a-actions-operations.md) and
[14 Action connectors](../spec/14-actions-connectors.md), decided in
[ADR 0007](../adr/0007-typed-actions-with-operator-policy.md)) lets an agent _use_ a vault
credential without receiving it. You define a **target**: where the agent may go, which vault
item signs in there, what it may do, and which clients may use it. The agent names the target
and describes an operation; vaultgate fetches the credential, performs the operation inside your
policy, scrubs the result of every injected value and returns it.

This guide is for the operator. It covers what exists today: the layer's switches, the account
page that manages targets, the target forms of every connector that has landed — `http` (with the
Microsoft Graph credential adapter), `sql`, `ssh` and `winrm` — and what an agent does with those
targets through `http_request`, `sql_query`, `sql_execute`, `ssh_run` and `winrm_run`. The
`browser` connector lands with M15; until then its targets cannot be created.

## Enabling the layer

The layer is off unless the deployment says otherwise, and each connector has its own switch:

```bash
VAULTGATE_ENABLE_ACTIONS=true
VAULTGATE_ACTIONS_ENABLE_HTTP=true
VAULTGATE_ACTIONS_ENABLE_SQL=true
VAULTGATE_ACTIONS_ENABLE_SSH=true
VAULTGATE_ACTIONS_ENABLE_WINRM=true
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

Below the table, **Unexpected writes** opens the cross-target review of every call that changed
something without a human's confirmation; it is described under
[Sessions, calls and the audit trail](#sessions-calls-and-the-audit-trail).

Every change (create, edit, enable, disable, delete, grant, remove a grant, close sessions) needs
a fresh password confirmation under **Sensitive actions**; the confirmation lasts five minutes,
as for every other sensitive action. Until then the pages show the target but offer no form.

A target whose stored documents no longer pass validation (for example after an upgrade that
tightened a rule) is marked `target_invalid` with the reason, refuses every call, and can be
repaired or deleted from its page.

### When a save is rejected

Nothing is saved until every check passes, and every problem is reported at once rather than one
per attempt. A problem that names a field in the form is shown against that field, with a
sentence saying what the field is for and the exact complaint in brackets — so
`Too small: expected number to be >=1000` against **Timeout (ms)** reads as "How long one call
may run, in milliseconds: 1000 to 300000. (Too small: expected number to be >=1000)". A problem
that names no field — the destination as a whole, the vault item's fields, a credential mapping —
is listed under the banner at the top. The form is re-shown with exactly what you submitted, so
nothing has to be typed again.

### Confirmation is on for a new target

**Ask a human to confirm every non-read call** starts on for every new target, whatever the
connector. While it is on, a call that would change something answers the agent's client with an
elicitation prompt, and runs only once a human ticks the box; see
[Confirmation](tools-and-scopes.md#confirmation). If you turn it off on a target whose policy
allows anything but a read, its page carries a standing note saying so, and every such call
appears in **Unexpected writes**.

The confirmation needs a client on MCP protocol revision `2026-07-28`. A client on an older
revision is refused every non-read call on that target with `confirmation_unavailable`, and no
fallback is possible — the older wire declares elicitation only during `initialize`, which
vaultgate's stateless per-request handler never sees. Reads still work. If your agent's client is
older, use one on `2026-07-28` or turn the confirmation off and review the writes here.

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

A target's vault item must be one vaultgate has already synced. The vault is synced on the
interval `VAULTGATE_BW_SYNC_INTERVAL` sets (15 minutes by default), so an item created in the
vault moments earlier is not yet visible and saving the target is refused with
`credential.item_id: no such item in the vault`. Wait for the next sync, which the log records as
`vault synced`, and save again.

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
   and is audited as such. A malformed argument (a path with `..`, an empty segment `//`, or a
   percent-encoded slash or backslash — `%2F`, `%5C` — anywhere before the query string; a
   header name that is not a token; more than 32 headers) is `invalid_arguments`. The encoded
   separators are refused because normalisation decodes the unreserved characters only, so
   neither the dot-segment rule nor a `*` in a pattern would treat one as a boundary while a
   destination that decodes it before routing does. Put them in the query string instead. The URL that
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
   row before anything leaves the engine — and for a body that is not text the replacement
   happens on the raw bytes, before they are base64-encoded, so the encoding cannot hide a
   credential the destination sent.

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

**`require` here is not PostgreSQL's `sslmode=require`.** In `psql` and in most PostgreSQL
tooling, `require` means "encrypt, and do not check who is on the other end"; vaultgate's
`require` verifies the certificate fully against the system trust store, so it is closer to
PostgreSQL's `verify-full`. If you carry PostgreSQL habits across, expect vaultgate's `require`
to refuse a server whose certificate `psql` accepted without complaint: a self-signed
certificate, a private CA the host does not trust, or a name that does not match. The answer is
`verify-full` with the issuing CA's PEM, not a weaker mode — there is no "trust the server
certificate" option, because ACT-57 leaves no room for one.

**A destination named by address.** A `host` that is an IP literal has no name to put in the TLS
server-name extension, so the certificate is verified against its IP subject-alternative names
instead, which is the correct verification for an address. PostgreSQL targets do this and work.
SQL Server targets cannot: its driver puts the server name straight into the TLS handshake,
which refuses an address, and its in-band TLS path leaves nothing else to verify against. Such a
target is refused when you save it, with a message saying so; give the host the name the
certificate carries, or — on a private network where that is impossible — make it an **internal**
target with `tls: "disable"` and accept plain transport knowingly.

Saving resolves the host and checks every address against the private-range rule; it does not
connect.

**Credential mapping.** The vault item id, the field holding the **login name**
(`login.username` by default) and the field holding the **password** (`password` by default).
Both are `get_secret` selectors, so a hidden custom field (`custom.<name>`) works for either.

**Policy.** `operations`: `read` alone for a reporting replica, `read` and `write` for a target
an agent may change (a target that allows `write` must allow `read` too). Then **maximum rows**
(default 500, at most 10 000), the **statement timeout** (the server cancels a statement that
runs longer; defaults to the call timeout and is never longer than it), and the common timeout,
output and rate limits.

Two more fields matter only to `sql_execute`:

- **Allowed write classes**: `dml` (`INSERT`, `UPDATE`, `DELETE`, `MERGE`) by default; add `ddl`
  (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`) only for a target whose
  agent is meant to change the schema.
- **Allowed statements**: one pattern per line, matched against the statement as the agent wrote
  it; `*` matches within one line — it stops at a line feed and at a carriage return — and
  matching is anchored at both ends, so
  `UPDATE orders SET status = $1 WHERE id = $2` admits exactly that statement and
  `DELETE FROM sessions WHERE *` admits any single-line delete from that table. An empty list
  means no statement restriction, and the classification and the login are then the controls.

**Ask a human to confirm every non-read call** is on for every new target and is what makes
`sql_execute` safe to grant at all; see "Calling a `sql` target" below.

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

`DENY EXECUTE` covers the procedures in _this_ database, and nothing else. It does **not** stop
`EXEC sp_who` or its siblings: those live in `master`, where `public` may execute them, and a
login that can connect at all can reach them. What refuses them is vaultgate's classifier, which
rejects any statement naming an `sp_`/`xp_` identifier — before a connection exists, so the
server is never asked. Treat the `DENY` as tidying up your own procedures; treat the classifier
plus the least-privilege login as the controls.

For a target that also allows `write`, grant the least the work needs and nothing more — on the
tables it is meant to change, in the schemas it is meant to see. PostgreSQL:

```sql
CREATE ROLE vaultgate_writer LOGIN PASSWORD 'put-a-generated-password-here';
GRANT CONNECT ON DATABASE reporting TO vaultgate_writer;
GRANT USAGE ON SCHEMA support TO vaultgate_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.tickets TO vaultgate_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA support TO vaultgate_writer;
```

SQL Server:

```sql
CREATE LOGIN vaultgate_writer WITH PASSWORD = 'put-a-generated-password-here';
USE reporting;
CREATE USER vaultgate_writer FOR LOGIN vaultgate_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::support TO vaultgate_writer;
DENY ALTER, CONTROL ON SCHEMA::support TO vaultgate_writer;
DENY EXECUTE TO vaultgate_writer;
```

Give a write target its own login: do not reuse the read one. A login that can only touch the
tables you named is the control that holds when everything above it is wrong, and it is the
reason vaultgate has no "allowed schemas" list of its own — it could not tell a schema
qualifier from a table alias without a SQL parser, and a check that cannot tell them apart
either refuses ordinary statements or gives you a false sense of safety.

Store each password in a vault item and point the target's credential mapping at it. Rotating it
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
   `policy_denied` with `detail.reason: "statement_count"`. A `--` comment ends at the first
   line terminator, carriage return as well as line feed, as both engines' lexers do. It must then classify as `read`:
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
   comments: `$1…$n` on PostgreSQL, `@p1…@pn` on SQL Server. (A statement may not carry a NUL
   byte or any other control character but tab, carriage return and line feed; one that does is
   `invalid_arguments`.) A placeholder with no parameter, a
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
   encoding is replaced by `[redacted:<field>]` before the result leaves the engine. A decimal
   string carries the scale its column declares, so a `decimal(10,2)` holding 3.50 comes back as
   `"3.50"`.

   SQL Server has one limit vaultgate cannot lift. Its driver parses `decimal`, `numeric`,
   `money` and `smallmoney` into a JavaScript number inside Tedious's own value parser, before
   `mssql`'s `valueHandler` registry — the only hook the driver offers — is consulted, so the
   digits are gone before anything vaultgate controls runs. The declared scale recovers every
   value whose unscaled integer still fits a JavaScript safe integer, which is all ordinary
   money. A larger one has genuinely been rounded, and rather than hand an agent a plausible
   wrong number the call fails with `connector_fault` and
   `detail.reason: "exact_numeric_precision"`, naming the column. Cast that column to `varchar`
   in the statement — `CAST(total AS varchar(50))` — and every digit comes through. PostgreSQL
   has no such limit: its driver hands decimals over as strings already.

A SQL error raised after sign-in — a bad column name, a permission denied — is `upstream_error`
with the server's message (scrubbed, capped at 1 KiB). A login the server rejects is
`authentication_failed`, an unreachable or refused server is `connection_failed`, a certificate
that does not verify is `tls_error`, and a statement the server cancels at the statement timeout
is `timeout`. `connector_fault` is the one code that is not the destination's doing: it means the
call failed inside vaultgate, possibly without the destination ever being contacted, and
`detail.reason` says which — please report one whose reason is `internal`.

## Changing data through a `sql` target

An agent whose token holds `actions:sql.write`, whose client you granted the target, and whose
target policy includes the `write` operation calls `sql_execute`:

```json
{
  "target": "warehouse",
  "statement": "UPDATE support.tickets SET status = $1 WHERE id = $2",
  "params": ["closed", 4711]
}
```

Everything in "Calling a `sql` target" applies, with four differences:

1. **The classification must be a write.** The statement's first keyword must be `INSERT`,
   `UPDATE`, `DELETE` or `MERGE` (`dml`), or — only when **Allowed write classes** includes
   `ddl` — `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE` or `DENY`. A `SELECT`
   through `sql_execute` is refused (`policy_denied`, `statement_class`) and belongs in
   `sql_query`; a `DELETE` through `sql_query` is refused the same way. Neither tool can be
   talked into doing the other's work, whatever scopes the token holds.
2. **Then the statement allowlist**, if the target carries one: a statement outside it is
   `policy_denied` with `detail.reason: "statement_pattern"`.
3. **A human confirms it**, unless you untick **Ask a human to confirm every non-read call**.
   The agent's client shows the target, the destination (host, port and database only) and the
   statement, and asks for one tick. The confirmation lasts two minutes, is bound to this call's
   exact arguments and to this target at this revision, and cannot be used twice: editing the
   target, changing a parameter, retrying with another token or answering late all fail
   (`confirmation_invalid`, `confirmation_expired`, `confirmation_reused`). A client that cannot
   elicit is refused with `confirmation_unavailable` before the vault is touched — vaultgate
   never downgrades a confirmed target to an unconfirmed one.
4. **It runs in its own transaction**, committed when the statement succeeds and rolled back on
   any error; if the policy timeout elapses the connection is dropped, which rolls it back too.
   The result is `rows_affected`, the rows the statement returned through `RETURNING` or
   `OUTPUT` (empty when it returned none) and `duration_ms`.

The statement the agent ran is kept in the call history, scrubbed, whether it was confirmed or
not, so an unexpected write can be read back on the target's page.

## Creating an `ssh` target

Follow **Create an ssh target**. An `ssh` target is the sharpest tool here: a granted client can
run a command on a real server. Two things carry most of the safety — the account it signs in as,
and the list of commands it may run — and neither is something vaultgate can choose for you.

**Destination.** The `host`, the `port` (22 by default), the **login name** the command runs as,
and the **host key**.

There is no trust-on-first-use and no way to skip the host-key check: a server presenting any
other key fails the call with `host_key_mismatch`, during the key exchange, before the
credential is offered. Read the key off the server the first time, over a channel you trust:

```bash
ssh-keyscan -t ed25519 build.example.com
# build.example.com ssh-ed25519 <the base64 public key>
```

Paste that line into **Host key** — with or without the host in front, with or without the
comment at the end. `ssh-keygen -lf` prints the same key as a fingerprint
(`SHA256:` followed by a base64 digest), and the field takes that form too. The safest source is the server itself:
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, read over your existing administrative
access, rather than `ssh-keyscan` from a host that may be answered by somebody else. Rotating the
server's key means editing the target, which bumps its revision and voids any open confirmation.

vaultgate offers the library's modern algorithms with `ssh-rsa` (the SHA-1 signature algorithm)
removed, so a server that can only do `ssh-rsa` cannot be reached; `rsa-sha2-256` and
`rsa-sha2-512` on the same RSA host key are fine.

**Credential mapping.** The vault item id, and either a key or a password.

- **key** (the better choice) reads the private key from the item's `sshKey.privateKey` — a
  Bitwarden **SSH key** item — and, when the key has one, a passphrase from a field you name
  (a hidden custom field, `custom.key-passphrase`, is the usual place). Put the matching public
  key in the server account's `authorized_keys`, ideally with `restrict` and a `from=` clause.
- **password** reads the password field of a login item. Use it only where a key cannot be
  installed.

The login name is part of the destination, not the vault item, so one key item can serve several
targets.

**Policy.** Either **allowed commands** — one glob pattern per line, matched against the whole
command, where `*` matches any run of characters except a newline — or **allow any command**.
Exactly one of the two: a target with neither allows nothing, and a target with both is refused.

```text
uptime
systemctl status nginx
journalctl -u nginx --since * --no-pager
```

Patterns are matched against the exact command the agent sends, anchored at both ends and
case-sensitively. A pattern that would match everything (`*`) is refused at save: saying
"anything" is a separate, deliberate decision.

### Giving the target its own user

The login is the control. Give each `ssh` target a dedicated account with the least privilege the
work needs, no sudo unless a specific command needs it, and a key restricted to it:

```bash
sudo useradd --create-home --shell /bin/bash vaultgate
sudo -u vaultgate mkdir -p ~vaultgate/.ssh
# in ~vaultgate/.ssh/authorized_keys, one line:
restrict,from="203.0.113.9" ssh-ed25519 <the base64 public key> vaultgate
```

`restrict` turns off port forwarding, agent forwarding, X11 and the pseudo-terminal, which
vaultgate never asks for anyway; `from=` limits the key to the address vaultgate calls from. If a
target genuinely needs one privileged command, grant that one command in `sudoers` with
`NOPASSWD` and nothing else, and allow exactly that command in the policy.

### Why "allow any command" needs the deployment's consent

An any-command target is a shell: whatever that login can do, a granted client can do. The
account page only offers the box when the deployment sets

```bash
VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND=true
```

so turning a target into a shell takes both a deployment change and an operator action. Such a
target carries a standing warning on its page, is reported to agents as `unrestricted: true`, and
has the full command of every call written to the audit trail. Turning the switch off later does
not quietly leave it working: every call is refused with `policy_denied` and agents stop seeing
the target at all. Leave `confirm_writes` on for these, so each call needs a human's approval.

## Calling an `ssh` target

An agent whose token holds `actions:ssh` and whose client you granted the target calls `ssh_run`:

```json
{
  "target": "build-host",
  "command": "systemctl status nginx"
}
```

`command` is at most 16 KiB, may not contain a NUL byte, and may not contain a newline or
carriage return unless the target is an any-command one; an optional `stdin` (at most 64 KiB) is
written to the command and closed, so a command that reads until end of file finishes.

The command is matched against the allowlist **before anything connects**; a command no pattern
matches is `policy_denied` with `detail.reason: "command"`. Then one connection is opened to the
address the host name resolved to, the presented host key is checked against the pinned one, the
credential is offered (and only the one method the mapping names: no agent, no
keyboard-interactive fallback), and one exec channel runs the command with no pseudo-terminal, no
X11, no environment of vaultgate's making and no port forwarding. There is no session: nothing —
no working directory, no variable, no background process — survives to the next call, and the
connection is closed when the call ends.

Out: `exit_code` (`null` when the command was signalled rather than exiting), `stdout` and
`stderr` captured separately and each cut at the target's **maximum output**, `truncated` and
`duration_ms`. A non-zero exit code is a result, not an error. Errors are reserved for the
connection: `host_key_mismatch`, `authentication_failed`, `connection_failed`, `timeout` (the
policy timeout, which also sends `KILL` to the remote command) and `upstream_error` for a
channel the server refused or broke. Every injected value, in every encoding, is replaced by
`[redacted:<field>]` before anything leaves the engine — including the audit trail, so a command
that echoes the private key is stored redacted.

## Creating a `winrm` target

Follow **Create a winrm target**. A `winrm` target runs a command on a Windows host over
WS-Management, the protocol behind `winrs` and PowerShell remoting. Like `ssh`, the account it
signs in as and the list of commands it may run carry most of the safety.

**Destination.** The **WS-Management endpoint**, the **login name**, the **shell**, and
optionally the **certificate fingerprint**.

The endpoint is the HTTPS listener: `https://build-agent.example.com:5986/wsman`. A plain
`http://` endpoint sends the password where anyone on the path can read it; vaultgate accepts one
only on a target you have marked **internal**, and says so when you save.

Set up the listener on the Windows host once, from an elevated PowerShell:

```powershell
$certificate = New-SelfSignedCertificate -DnsName 'build-agent.example.com' -CertStoreLocation Cert:\LocalMachine\My
New-Item -Path WSMan:\localhost\Listener -Transport HTTPS -Address * -CertificateThumbPrint $certificate.Thumbprint -Force
Set-Item -Path WSMan:\localhost\Service\Auth\Basic -Value $true
New-NetFirewallRule -DisplayName 'WinRM HTTPS' -Direction Inbound -Protocol TCP -LocalPort 5986 -Action Allow
```

`Basic` authentication is safe here **only because the transport is TLS** — it is what carries the
password, so never enable it on the plain HTTP listener, and leave that listener disabled
(`Remove-Item -Path WSMan:\localhost\Listener\<the HTTP listener> -Recurse`).

**The certificate fingerprint.** Leave it empty if the listener's certificate comes from a
certificate authority the vaultgate host already trusts. If it is self-signed — which is the usual
case — give its SHA-256 and vaultgate will accept that one certificate and nothing else. Read it
off the host you are configuring:

```powershell
# SHA-256 of the DER certificate the HTTPS listener presents
Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq (Get-Item WSMan:\localhost\Listener\*\CertificateThumbprint).Value |
  ForEach-Object { [System.BitConverter]::ToString((Get-FileHash -InputStream ([System.IO.MemoryStream]::new($_.RawData)) -Algorithm SHA256).Hash) }
```

or, from any machine that can reach it:

```bash
openssl s_client -connect build-agent.example.com:5986 </dev/null 2>/dev/null |
  openssl x509 -noout -fingerprint -sha256
```

Paste the 64 hexadecimal digits with or without the colons, in either case. The pin **replaces**
the system certificate store: a host presenting any other certificate fails the call with
`tls_error`, and because the socket is held closed until the certificate matches, the password is
never sent to it. Renewing the certificate means editing the target, which bumps its revision and
voids any open confirmation.

**Credential mapping.** The vault item id and the field holding the password (`password` unless
you say otherwise). The login name lives in the destination, so one item can serve several
targets.

**Shell.** `powershell` (the default) sends the command as a PowerShell `-EncodedCommand`, so
nothing re-parses the quoting the agent wrote; `cmd` sends a command line for `cmd.exe` to parse.
Prefer PowerShell unless you are allowing a classic console tool.

**Policy.** Exactly as `ssh`: either **allowed commands**, one glob pattern per line matched
against the whole command, or **allow any command** behind
`VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND=true`.

```text
Get-ComputerInfo
Get-Service -Name *
Restart-Service -Name Spooler
```

### Giving the target its own user

Create a dedicated local account, put it in **Remote Management Users** rather than
**Administrators**, and give it only what the allowed commands need:

```powershell
New-LocalUser -Name 'vaultgate' -Password (Read-Host -AsSecureString) -PasswordNeverExpires
Add-LocalGroupMember -Group 'Remote Management Users' -Member 'vaultgate'
```

A member of that group can open a WinRM shell but is not an administrator; grant any further
privilege the target genuinely needs one command at a time.

## Calling a `winrm` target

An agent whose token holds `actions:winrm` and whose client you granted the target calls
`winrm_run`:

```json
{
  "target": "build-agent",
  "command": "Get-Service -Name Spooler"
}
```

`command` is at most 16 KiB, may not contain a NUL byte or any other control character (tab,
carriage return and newline excepted), and may not contain a newline or carriage return unless
the target is an any-command one; an optional `stdin` (at most 64 KiB) is written to the command
and closed.

The command is matched against the allowlist **before anything connects**. Then one connection is
opened to the address the host name resolved to, the certificate is checked against the pin where
there is one, and one WS-Management shell is created for the call, runs the command, and is
deleted when the call ends. There is no session: nothing survives to the next call.

Out: `exit_code`, `stdout` and `stderr` captured separately and each cut at the target's
**maximum output**, `truncated` and `duration_ms`. A non-zero exit code is a result, not an error.
Errors are reserved for the connection: `tls_error` (the certificate is not the pinned one, or
does not verify), `authentication_failed` (a 401 from the listener), `connection_failed`,
`timeout` — which sends `Signal terminate` to the command and then deletes the shell — and
`upstream_error` for a fault the service reported, with its reason scrubbed and capped. The
`Basic` header vaultgate builds from the account name and the password is scrubbed as one value
too, so a listener that quotes the `Authorization` header back in a fault cannot hand the agent a
decodable pair.

## Grants

A target is usable by an OAuth client only while you have granted it, and only while that
client's consent stands. On the target's page, **Grants** lists the granted clients and lets you
grant among the clients currently connected (those on the account page's connected-clients
list) or remove a grant, which also closes that client's sessions on the target.

The connected-clients list on the account page shows the same grants from the other side: each
client's row has a **Targets** column listing the targets it may act on, with a **Remove** button
per grant and a picker for the targets it does not yet hold. Granting or removing from there does
exactly what the target's own page does — the same checks, the same audit event — and returns you
to the target concerned.

Disconnecting a client on the account page removes every grant it holds, so a reconnected client
starts with none. A grant never widens a token: the client still needs the connector's scope
(`actions:http`) at consent.

## Sessions, calls and the audit trail

The target's page shows its open sessions (browser sessions, a later milestone) with a **Close
sessions** button, and the last 50 calls with their time, tool, operation, classification,
outcome, elicitation result, output size and client. **The whole call history** below that table
pages back through the rest, 50 at a time, newest first, following **Older calls** until the
trail ends. Results are never stored; the arguments are, scrubbed, so an unexpected write can be
read back.

**Unexpected writes**, linked from the Actions section, is the same trail across every target,
narrowed to the calls that matter when something has gone wrong: every call that was not a read
and that no human accepted through a confirmation, newest first, with the time, the target, the
client, the tool, the classification, the outcome and an excerpt of the arguments. A target that
asks for confirmation on every non-read call appears here only when one was declined, cancelled,
expired or refused; a target with the confirmation off appears here for every write it makes,
which is the point. The rows of a deleted target stay (the audit trail outlives the target) and
name it without a link.

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
