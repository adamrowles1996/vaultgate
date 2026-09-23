# 14 Action connectors

> **Status: the interface (14.1), the `http` connector (14.2) and the `graph` credential adapter
> (14.3) have landed (M9, M10); `sql` is M11, `ssh` M12, `winrm` M13 and `browser` M15.** The
> connector contracts of the actions layer ([13 Actions](13-actions.md),
> [ADR 0007](../adr/0007-typed-actions-with-operator-policy.md)). A document whose runtime has
> not landed validates, but a target that uses it is refused at save (and on read) until it does,
> so no half-implemented mode ever runs. Requirement identifiers continue the `ACT-n` sequence of
> section 13.

## 14.1 Connector interface

Each connector is a sub-module of `src/actions/connectors/` implementing one interface
(`src/actions/connectors/connector.ts`). Its static half, `ConnectorSchemas`, is present in
every build so the account page can validate and edit targets of a connector whose runtime is
not loaded; the runtime half is imported dynamically only when the connector is enabled (ACT-73).

```ts
interface ConnectorSchemas<Destination, Credential, Policy> {
  readonly kind: 'http' | 'sql' | 'ssh' | 'winrm' | 'browser';
  readonly destinationSchema: z.ZodType<Destination>;
  readonly credentialSchema: z.ZodType<Credential>;
  readonly policySchema: z.ZodType<Policy>;
  /** The hosts a destination names and whether each is reached over TLS (ACT-3, ACT-55, ACT-57). */
  endpoints(destination: Destination): readonly Endpoint[];
  /** The vault fields a mapping needs, as `get_secret` selectors (ACT-4). */
  credentialFields(credential: Credential): readonly CredentialField[];
  /** Save-time rules beyond the schemas (ACT-79, ACT-81); each problem is shown to the operator. */
  saveProblems(documents: TargetDocuments<Destination, Credential, Policy>): readonly string[];
  /** The host (and database, base path or origin) for ACT-43 and the account page. */
  summariseDestination(destination: Destination): string;
}

interface Connector<Destination, Credential, Policy, Operation> extends ConnectorSchemas<
  Destination,
  Credential,
  Policy
> {
  /** The tools this connector serves (`sql` has two), each with its scope and its strict input schema minus `target`. */
  readonly tools: readonly ConnectorTool<Operation>[];
  /** What `actions_list_targets` may say about a target before the scope filter (ACT-19). */
  capabilities(destination: Destination, policy: Policy): TargetCapabilities;
  /** Pure: classifies and checks the operation against the policy; no I/O. The credential document names the injection point the operation may not touch (ACT-22). */
  authorize(policy: Policy, operation: Operation, credential: Credential): PolicyDecision;
  /** The ACT-43 operation summary and the ACT-60 classification. */
  describe(operation: Operation): OperationDescription;
  /** Runs one operation with the injected values; output is raw, the engine scrubs it. */
  run(
    context: RunContext<Destination, Credential, Policy>,
    operation: Operation,
  ): Promise<Result<ConnectorOutput, ActionError>>;
}
```

`RunContext` carries the parsed documents, the common policy fields, the `InjectedValues`
holder (ACT-50), the pinned endpoints (ACT-55), the `AbortSignal` of the policy timeout
(ACT-59), the output limit with its guard band (ACT-52) and a logger. `ConnectorOutput` is
`{ result, captured }`: `result` is the tool result before scrubbing and `captured` the byte
streams (`body`, `stdout`, `stderr`, `snapshot`) taken up to `max_output_bytes` plus the guard
band, which the engine scrubs, cuts and writes back into `result` under the same keys. The
ACT-35 rule for command patterns and the ACT-88 switch are applied by the targets service to
any policy document that carries `allowed_commands`/`any_command`, so a connector does not
repeat them.

- **ACT-78** `authorize` is pure and fully unit-tested; `run` takes an injected transport (a
  `fetch`-like function, a database client factory, an SSH client factory, an HTTPS request
  function, a CDP connection factory) so contract tests run against fakes (QG-2), and the live
  tests of each milestone run the same operations against the maintainer's systems (ACT-75).

## 14.2 `http`

| Document      | Fields                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `destination` | `base_url` (`https://` origin plus optional path prefix, no query or fragment; `http://` only when `internal: true`).                                                                                                                                                                                                                                                                                             |
| `credential`  | `mode` (`bearer` \| `basic` \| `header` \| `query` \| `graph`); `field` (a `get_secret` field selector such as `password` or `custom.api-key`); for `basic` also `username_from` (`login.username` or a field selector); for `header` the header `name`; for `query` the parameter `name`; for `graph` the adapter document of 14.3. `header` and `query` MAY carry a `prefix` (for example `Token` and a space). |
| `policy`      | Common fields; `allowed_methods` (default `["GET","HEAD"]`); `allowed_paths` (one or more patterns, ACT-34, matched against the path and query relative to `base_url`); `allowed_request_headers` (names; default `accept`, `content-type`, `if-none-match`); `response_headers`; `max_body_bytes` (default 256 KiB, max 4 MiB); `follow_redirects` (default `false`); `allow_query_credentials`.                 |

- **ACT-79** Injection modes: `bearer` sets `Authorization: Bearer <value>`; `basic` sets
  `Authorization: Basic base64(username:value)`; `header` sets `<name>: <prefix><value>`; `query`
  appends `<name>=<url-encoded value>` to the query string, after any query the agent gave, with
  `<prefix><value>` encoded by `encodeURIComponent`, one of the ACT-51 scrub variants (allowed
  only when `policy` sets `allow_query_credentials: true`, because query strings reach proxy and
  server logs). `graph` is 14.3.
- **ACT-80** Requests go through the pinned transport of `src/net/pinned-https.ts` (OAUTH-8),
  which has two schemes: `https:` verifies the certificate against the system store with no
  insecure option (ACT-57), and plain `node:http` serves an `http://` `base_url`, which only an
  `internal` target may have; both connect to the pinned address with the host name kept for
  SNI, the certificate check and `Host`. Every request carries `User-Agent: vaultgate/<version>`
  (the `package.json` version), the policy timeout as its `AbortSignal`, and its response body
  is read up to `max_output_bytes` plus the guard band of ACT-52, after which the stream is
  cancelled.

## 14.3 `graph` credential adapter

The adapter exists because Microsoft Graph is the API the maintainer's agents call most, and
because a bearer token obtained by OAuth is a credential vaultgate must own end to end: the
agent must never see the client secret, the refresh token or the access token.

- **ACT-81** `credential.mode = "graph"` is valid only when `base_url` is on the
  `https://graph.microsoft.com` origin exactly (a path prefix under it, such as `/v1.0`, is
  allowed; national clouds are another origin and are a post-M15 candidate). The adapter document
  holds `tenant_id` (a GUID or a domain name, validated by shape because it is placed in a URL
  path), `client_id` (a GUID), `grant` (`client_credentials` \| `refresh_token`), `scope`
  (default `https://graph.microsoft.com/.default`), `secret_field` (the vault field holding the
  client secret) and, for `refresh_token`, `refresh_token_field` (the vault field holding the
  refresh token; a hidden custom field is the expected home).
- **ACT-82** Before the request, the adapter obtains an access token from
  `https://login.microsoftonline.com/<tenant_id>/oauth2/v2.0/token` with the chosen grant, through
  the pinned transport; that host is resolved and validated by the ACT-55 and ACT-56 rules each
  time a token is exchanged (a call served from the cache exchanges nothing and so resolves
  nothing). The token endpoint's response is validated against a schema before a field is read
  (T33). The token is cached in process memory keyed by target id and `revision` until 60 s
  before its `expires_in`, is never stored, is never logged, and is an injected value for
  scrubbing (ACT-51). A `401` from Graph invalidates the cache and the request is retried once
  with a fresh token; a `401` on that attempt is the result. The token endpoint's own failures
  map to `authentication_failed` for `invalid_client` and `invalid_grant` (the OAuth error code
  is the only `detail`; the AADSTS description quotes the request and is not scrub-safe),
  `connection_failed`, `tls_error` or `timeout` for a transport failure, and `upstream_error`
  otherwise.
- **ACT-83** When the token endpoint returns a new `refresh_token` (Microsoft rotates them), the
  adapter writes it back to `refresh_token_field` of the vault item through `VaultClient` and
  records `actions.credential_rotated` (target name, item id, field name; never the value). The
  write-back happens **before** the Graph request, and a failed one fails the call with
  `credential_rotation_failed` so the operator learns before the old token expires. This is the
  only path by which the actions layer writes to the vault and it needs no agent scope; the
  fields it can write are the ones `ItemPatch` expresses (a custom field, the login password, the
  notes), and any other selector is `credential_rotation_failed` with `detail.reason`
  `unwritable_field`.

## 14.4 `sql`

| Document      | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `destination` | `engine` (`mssql` \| `postgres`); `host`; `port` (default 1433 / 5432); `database`; `tls` (`require` default, `verify-full` with `ca_pem`, or `disable` only when `internal: true`); for `mssql`, `encrypt: true` is implied by `tls` and `trust_server_certificate` defaults to `false`.                                                                                                                                             |
| `credential`  | `username_from` (`login.username` or a field selector) and `password_field` (default `password`).                                                                                                                                                                                                                                                                                                                                     |
| `policy`      | Common fields; `operations` (`["read"]` default, or `["read","write"]`); `max_rows` (default 500, max 10 000); `statement_timeout_ms` (default `timeout_ms`); `write_classes` (`["dml"]` default, or `["dml","ddl"]`); `statement_allowlist` (optional patterns, ACT-34, applied to `sql_execute` statements after classification); `schemas` (optional list; a statement naming a schema outside it fails, best-effort, see ACT-38). |

- **ACT-84** Dependencies: `pg` for PostgreSQL and `mssql` (the Tedious-based driver) for SQL
  Server, justified per QG-9 in the M11 pull request (pure JavaScript, no native addon, parameter
  binding, TLS, per-statement timeouts). Each is imported only inside its sub-module, so a
  deployment that never enables `sql` still ships the packages but never loads them.
- **ACT-85** The documented setup for every `sql` target is a dedicated login: for read targets
  `db_datareader` / a role with `SELECT` only; for write targets the least role that covers the
  intended DML. vaultgate additionally opens read sessions read-only where the engine allows it
  (`SET default_transaction_read_only = on` and `BEGIN READ ONLY` on PostgreSQL; on SQL Server the
  classification of ACT-37 is the control, and the guide says so).
- **ACT-86** One connection per call, opened after the policy decision, closed when the call ends;
  no pool, so an idle deployment holds no database sessions and a rotated password takes effect on
  the next call.

## 14.5 `ssh`

| Document      | Fields                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `destination` | `host`; `port` (default 22); `username`; `host_key` (the server's public key line as `ssh-keyscan` prints it, or a `SHA256:` fingerprint). Required: there is no trust-on-first-use. |
| `credential`  | `auth` (`key` \| `password`); for `key`, `key_field` (default `sshKey.privateKey`) and optional `passphrase_field`; for `password`, `password_field` (default `password`).           |
| `policy`      | Common fields; exactly one of `allowed_commands` (one or more patterns, ACT-34) or `any_command: true`.                                                                              |

- **ACT-87** Dependency: `ssh2` (pure JavaScript; its optional native binding is not installed),
  justified in the M12 pull request. The host key presented at connect MUST match `host_key` or
  the call fails `host_key_mismatch` before authentication; key algorithms and ciphers are the
  library's modern defaults with `ssh-rsa` (SHA-1) disabled.
- **ACT-88** `any_command: true` is accepted at save only when the deployment sets
  `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND=true`, the target page shows a standing warning for such a
  target, and `actions_list_targets` reports its `operations` as `["shell"]` with
  `unrestricted: true`. Every call on such a target is audited with the full command.

## 14.6 `winrm`

| Document      | Fields                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `destination` | `url` (`https://host:5986/wsman`; `http://` only when `internal: true`, and then a warning is shown); `username`; `shell` (`powershell` default \| `cmd`); `certificate_sha256` (optional pin; when absent the system CA store verifies the host). |
| `credential`  | `password_field` (default `password`).                                                                                                                                                                                                             |
| `policy`      | As `ssh` (14.5): `allowed_commands` or `any_command: true`.                                                                                                                                                                                        |

- **ACT-89** Transport is WS-Management over HTTPS with `Basic` authentication over TLS in v1
  (NTLM and Kerberos are post-M15 candidates). The M13 pull request evaluates the npm WinRM
  clients per QG-9; a hand-written client on `node:https` is the expected outcome, because the
  protocol subset needed is five SOAP operations (`Create` shell, `Command`, `Receive`, `Signal`,
  `Delete`) and the existing packages carry dependencies or native bindings out of proportion to
  that. The choice is recorded in the plan when made.
- **ACT-90** The remote shell is created with a fixed idle timeout, `Receive` is polled until the
  command state is `Done` or the policy timeout elapses, and on timeout `Signal` (`terminate`) is
  sent before `Delete`.

## 14.7 `browser`

A `browser` target is a website the operator signs in to with a vault item. vaultgate performs
the sign-in in a headless Chromium it controls, then lets the agent drive that signed-in page
through the `browser_*` tools (13.6.6). The trust an operator extends by granting a browser
target is **equal to a shell**: the agent can do anything the logged-in user can do on the
allowed origins. The design therefore treats every session as a shell session with a TTL.

| Document      | Fields                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `destination` | `origins` (one or more exact origins, `https://` unless `internal: true`; navigation is confined to them); `login_url` (under one of `origins`); optional `login_form` (`username_selector`, `password_selector`, `totp_selector`, `submit_selector`; CSS selectors that override the heuristics of ACT-93); optional `logged_in_check` (a CSS selector that must be present after login, or a URL prefix). |
| `credential`  | `username_from` (`login.username` default); `password_field` (`password` default); `totp` (`auto` default: type the item's TOTP code when the item has one and the page asks; `never`).                                                                                                                                                                                                                     |
| `policy`      | Common fields; `operations` (`["read"]` default: open, navigate, snapshot, screenshot, close; or `["read","act"]` adding click and type); `screenshots` (default `false`); `session_ttl_s` (idle, default 900, max 3 600); `max_sessions` (per client, default 1, max 4); `confirm_writes` applies to `act` calls.                                                                                          |

### 14.7.1 Sidecar architecture

- **ACT-91** The browser never runs in the vaultgate process or image. Chromium runs as a
  **sidecar container** built from Microsoft's Playwright image at a pinned, checksummed tag,
  started headless with its DevTools endpoint bound to the container's internal-network
  interface only. vaultgate reaches it over the Chrome DevTools Protocol at
  `VAULTGATE_ACTIONS_BROWSER_CDP_URL` (13.14) through `playwright-core`'s `connectOverCDP`
  (ACT-72). The core image stays browser-free, so a deployment that never enables the connector
  carries none of Chromium's size or CVE surface.
- **ACT-92** `docker-compose.yml` gains an optional `browser` service under a Compose profile
  (`--profile browser`) on a dedicated internal network shared only with `vaultgate`: no published
  port, `cap_drop: [ALL]`, the Playwright-recommended seccomp profile, `read_only` root filesystem
  with `tmpfs` for `/tmp` and the profile directory, a memory limit (1 GiB default), a `pids`
  limit, `no-new-privileges`, and a `shm_size` adequate for Chromium. The Azure template gains an
  optional parameter (`deployBrowserSidecar`, default `false`) that adds the browser as a second
  container of the Container App, reached on the app's shared loopback, with its own CPU and
  memory reservation. At start-up with the connector enabled, vaultgate probes the endpoint
  (`/json/version`) and logs its readiness; a sidecar that is absent later answers every browser
  call `browser_unavailable`.
- **ACT-93** Each session is a fresh, isolated browser context (own cookie jar and storage,
  nothing persisted to disk) created on demand and destroyed on close; contexts share the one
  Chromium process, which is acceptable because every context belongs to the same operator's
  targets and the sidecar holds nothing else. The sidecar is restarted by its own health check
  (the DevTools endpoint stops answering) and by vaultgate at most once per hour on a schedule the
  operator can disable, to bound memory growth; open sessions are closed with `close_reason:
error` when that happens.

### 14.7.2 Sign-in

- **ACT-94** `browser_open` (ACT-29) MUST verify, before typing anything, that the vault item's
  login URIs match the origin of `login_url` (Bitwarden's default host match), so a credential can
  only be typed into the site it belongs to; a mismatch is `login_failed` (`stage: form`) and is
  reported on the target page. The engine then locates the fields: the operator's `login_form`
  selectors when given, else `input[autocomplete=username]`/`input[type=email]`/the first text
  input for the username, `input[type=password]` for the password, and
  `input[autocomplete=one-time-code]` for TOTP, handling the two-step pattern (username, submit,
  then password) by retrying the search after navigation. Values are inserted through CDP text
  insertion, never through a URL, a script the page can observe, or the clipboard. When a TOTP
  field appears and the item has a TOTP seed, the current code is generated exactly as
  `get_secret(totp)` does and typed; the seed never leaves the vault client.
- **ACT-95** Login is judged successful when the page leaves `login_url`, the `logged_in_check`
  (if any) passes, and the landing URL's origin is in `origins`. Every other outcome (still on the
  login page, an error banner, a redirect elsewhere, a CAPTCHA, an unexpected second factor) is
  `login_failed` with `detail.stage` and no snapshot: the agent never sees the login page. The
  password and TOTP code are injected values for the session's scrub list (ACT-50) so a page that
  echoes them (an error message, a hidden input) is scrubbed for the session's lifetime.

### 14.7.3 Session model

- **ACT-96** A session id is `vg_bs_` plus 32 random bytes base64url, returned once, stored as its
  SHA-256 in `action_sessions` (13.13) with the client and token prefix that opened it. Every
  browser call touches `last_used_at`. A session ends, and its context is destroyed, when: the
  agent closes it; `session_ttl_s` passes without a call (`idle`); 3 600 s pass since open
  (`absolute`); the token that opened it, or any token of the same family, is revoked, or the
  client's consent or grant is revoked (`revoked`); the target is edited, disabled or deleted
  (`target_changed`); the operator presses "close sessions" (`operator`); vaultgate shuts down
  (`shutdown`); or the sidecar is lost (`error`). `max_sessions` bounds open sessions per client
  per target; the next `browser_open` is `session_limit` until one closes. A call on a closed
  session is `session_expired`; on an id that never existed for this client, `unknown_session`.
- **ACT-97** Sessions are bound to the client that opened them, not only to the token: a
  refreshed token of the same client continues the session, any other client gets
  `unknown_session`. The engine never lists sessions to agents; `actions_list_targets` reports
  only whether the caller has an open session on a target.

### 14.7.4 Confinement and scrubbing

- **ACT-98** Navigation confinement: every top-level navigation, whether from `browser_navigate`,
  a click, a form submission, a redirect or a script, is intercepted (Playwright request routing
  on the context) and aborted unless its origin is in `origins`; an aborted navigation leaves the
  page where it was and the call returns `policy_denied` (`reason: origin`). Sub-resource requests
  (scripts, images, XHR) to other public origins are allowed, because pages need them; sub-resource
  requests to an IP-literal in a range ACT-56 refuses are aborted; and, because Chromium resolves
  names itself, name-based private destinations are the sidecar network's responsibility: the
  Compose network is internal with no route to the host's private ranges, the Azure sidecar has no
  private endpoints, and the guide states that an operator who attaches the sidecar to a wider
  network has removed a control. Downloads are disabled at the context; `window.open` targets are
  closed unless their origin is allowed; permission prompts (camera, location, notifications)
  are denied.
- **ACT-99** No cookie or storage export, ever: no tool, page, log or export returns cookies,
  local or session storage, IndexedDB, cache, the DevTools URL, a HAR, a trace or a profile
  directory, and the context is never persisted. This is an invariant of the connector, tested by
  the contract suite against a page that plants marker cookies, and the `browser_*` output schemas
  have no field that could carry such data.
- **ACT-100** Snapshots (ACT-31) are built from the accessibility tree; password inputs are
  emitted as `[password field]` regardless of their value, and every node whose name, value or
  description contains a session scrub-list value is emitted as `[redacted:<field>]` before the
  ACT-51 pass over the text. Screenshots (ACT-33) are taken only after the engine has, in the
  page, set every `input[type=password]` to render as masked discs (they already do; the engine
  reasserts it against a page that unmasked itself) and replaced the text of every DOM text node
  and the value of every input containing a scrub-list value with the redaction marker, restoring
  them after capture. A screenshot is refused with `policy_denied` (`reason: element`) when the
  replacement cannot be applied (a canvas or a cross-origin frame contains a scrub-list value
  vaultgate cannot edit), and the guide says screenshots are the leakier of the two and are off by
  default.
- **ACT-101** Every browser call is audited (ACT-60) with the session id, the page URL before and
  after, and, for `browser_type`, the typed text (never an injected value, which ACT-32 refuses
  and ACT-51 would scrub); snapshots and screenshots are never stored.

### 14.7.5 Verification

- **ACT-102** The contract suite runs against a fake CDP endpoint and a fixture site served
  in-process (login form, two-step login, TOTP prompt, a page that echoes the password in an
  error banner, a page that plants cookies and opens a window to a foreign origin, a page with a
  password field that unmasks itself) and asserts every ACT-94…101 behaviour, including the
  canary rules of ACT-53 over snapshots and the pre-screenshot DOM. The live test of M15 signs in
  to two of the maintainer's own web applications through the Compose sidecar and records the
  evidence in the milestone pull request.
