# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `sql` connector runtime and `sql_query` (spec 14 §14.4 and spec 13 §13.6.4, M11 first pull
  request; ACT-23, ACT-24, ACT-26, ACT-36, ACT-37, ACT-38, ACT-77, ACT-84, ACT-85, ACT-86): the
  tool is listed on a deployment with `VAULTGATE_ENABLE_ACTIONS=true` and
  `VAULTGATE_ACTIONS_ENABLE_SQL=true` for tokens holding `actions:sql.read`. A `sql_query` names
  a granted target and gives exactly one statement (at most 64 KiB) and up to 100 positional
  parameters. The statement is tokenised in the target's own dialect — `'…'` with doubled
  quotes, `N'…'` on SQL Server, `E'…'` and `$tag$…$tag$` on PostgreSQL, `"…"` and `[…]` quoted
  identifiers, line comments and block comments that nest on PostgreSQL — and refused before any
  connection is opened when it is more than one statement (`policy_denied`,
  `statement_count`) or does not classify as a read (`policy_denied`, `statement_class`); the
  class it was given is recorded on the refused call as well as on the call that ran. Parameters
  bind to `$1…$n` (PostgreSQL) or `@p1…@pn` (SQL Server), counted in the tokenised statement, and
  any mismatch is `invalid_arguments`; there is no interpolation path. One connection is opened
  per call after the policy decision, to the address the engine resolved and validated once, with
  the host name kept for TLS (SNI and certificate verification, `verify-full` against a
  `ca_pem`; there is no way to skip verification), and closed in `finally` — no pool, so a
  rotated password takes effect on the next call. PostgreSQL sessions are opened read-only
  (`SET default_transaction_read_only = on` and `BEGIN READ ONLY`); on SQL Server the
  classification and the least-privilege login are the controls, and the guide says so. The
  result carries the columns with the engine's own type names, the rows as arrays of JSON
  scalars (ISO 8601 dates, base64 binary, decimals and 64-bit integers as strings), the row
  count, `truncated` and `duration_ms`; rows are dropped whole at `max_rows` and at
  `max_output_bytes`, so no value is ever cut in half. Driver failures map to
  `authentication_failed`, `connection_failed`, `tls_error`, `timeout` and `upstream_error` with
  the server's message scrubbed and capped at 1 KiB. Contract tests run the connector against
  fake sessions and both real session modules against fake drivers, with the ACT-77 corpus as
  one named test per statement per engine, the ACT-53 canary suite through the engine and a
  parameterised query through the MCP client SDK. A target whose policy asks for the `write`
  operation is refused at save until `sql_execute` lands with M11's second pull request.
  Operator guide: `docs/guides/actions.md` ("Creating a `sql` target", "Calling a `sql` target",
  with the `CREATE ROLE`/`CREATE LOGIN` examples); tool reference:
  `docs/guides/tools-and-scopes.md`.

### Changed

- `Connector.authorize` and `Connector.describe` receive the target's destination document as
  well (spec 14 §14.1): a SQL statement cannot be tokenised without knowing which dialect it is
  written in, and reading one with the other engine's rules would let a statement separator hide
  inside what the other engine calls a string. `ConnectorOutput` gains an optional `bytes`, so a
  connector whose result is not a byte stream (the `sql` rows) still reports `output_bytes` to
  the `action_calls` row. The `http` connector's implementations are unchanged.
- The `action_calls` classification is recorded for a call the policy refused, not only for a
  call that ran (ACT-26, ACT-60), so an operator reading a target's history sees what a refused
  statement was taken to be.
- The certificate and TLS error codes are classified in one place (`src/net/tls-error.ts`) for
  the pinned HTTPS transport and the database drivers alike, instead of once per connector.

### Dependencies

- Added `pg` 8.23.0 and `mssql` 12.7.2 (ACT-84, QG-9), each imported only from inside its own
  session module through a dynamic import, so a deployment that never enables `sql` never loads
  either. Both are pure JavaScript with no native addon and no install script; `pg-native` is an
  optional peer dependency and is not installed. Added `@types/pg` 8.23.1 and `@types/mssql`
  12.3.0 as development dependencies (type declarations only; neither ships).

## [0.1.0-rc.7] - 2026-09-23

### Added

- `graph` credential adapter for `http` targets (spec 14 §14.3, M10; ACT-81, ACT-82, ACT-83): a
  target whose `base_url` is on `https://graph.microsoft.com` may map its credential as
  `mode: "graph"`, and `http_request` then behaves exactly as it does on a bearer target while
  vaultgate obtains the Microsoft Graph access token itself. The adapter document names the
  tenant (a GUID or a domain name), the application id, the grant (`client_credentials` or
  `refresh_token`), the scope and the vault fields holding the client secret and, for the
  refresh grant, the refresh token; the M9 save-time refusal of the mode is gone and a `graph`
  mapping is checked like any other (ACT-4). Before the request the adapter posts the grant to
  `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` through the pinned transport,
  resolving and validating that host by the same private-range rule as any destination, and
  validates the response against a schema before reading a field. The token is held in process
  memory only, keyed by target id and revision and given up 60 s before it expires (the one
  caching exception of ACT-50); it is never stored, never logged, and is redacted from every
  result, row, log line and elicitation message as `[redacted:graph.access_token]`, in every
  ACT-51 encoding. A `401` from Graph discards it and the request is retried once with a fresh
  token; a `401` on that attempt is the result. When the token endpoint rotates the refresh
  token, the new one is written back to the mapped vault field **before** the Graph request and
  an `actions.credential_rotated` event is recorded (target, item id, field name, never the
  value); a write-back that fails fails the call with `credential_rotation_failed` so the
  operator learns while the old token still works. Token-endpoint failures map to
  `authentication_failed` for `invalid_client` and `invalid_grant` (the OAuth error code is the
  only detail; the AADSTS description is not scrub-safe), to `connection_failed`, `tls_error`
  or `timeout` for a transport failure, and to `upstream_error` otherwise. Contract tests cover
  both grants, the cache and its 60 s margin, a revision change, the `401` retry and the
  absence of a loop, rotation and a failed write-back, every error mapping, and an ACT-53 canary
  suite through the engine in which the fake Graph echoes the `Authorization` header and the
  fake token endpoint echoes the form it was posted. Operator guide: `docs/guides/actions.md`
  ("Microsoft Graph targets").

### Changed

- `VaultClient.updateItem` can write custom fields (`ItemPatch.customFields`): a named field
  keeps its kind and takes the new value, a name the item does not carry is created `hidden`.
  This is what the ACT-83 refresh-token write-back uses; it is the only path by which the
  actions layer writes to the vault, and it needs no agent scope.

### Fixed

- The account page's create-target form carried no `connector` field, while `POST /account/actions`
  reads the connector from the submission, so creating a target from a browser answered `404` and
  no target could be created through the operator pages at all (spec 13 §13.3.2, ACT-2, ACT-6).
  The create form now carries the connector as a hidden field, and the create-page test submits
  exactly the controls the rendered form carries rather than a hand-written field set, so a field
  the form forgets to render fails the suite. Found by the M9 live test against both reference
  deployments on v0.1.0-rc.6.

## [0.1.0-rc.6] - 2026-09-23

### Added

- `http` connector runtime and `http_request` (spec 14 §14.2 and spec 13 §13.6.3, M9 fourth pull
  request; ACT-20, ACT-21, ACT-22, ACT-79, ACT-80): the tool is listed on a deployment with
  `VAULTGATE_ENABLE_ACTIONS=true` and `VAULTGATE_ACTIONS_ENABLE_HTTP=true` for tokens holding
  `actions:http`. An `http_request` names a granted target and gives a method, a path with an
  optional query string, up to 32 headers and a string or JSON body; the policy decision is pure
  (method, normalised path and query against `allowed_paths`, header allowlist with
  `Authorization`, `Cookie`, `Host`, `Content-Length`, `User-Agent`, `Transfer-Encoding`,
  `Proxy-*` and the credential's own header always refused, body size), the credential is placed
  by its mapping (`bearer`, `basic`, `header` with a prefix, or `query` URL-encoded after the
  agent's query and only with `allow_query_credentials`), and the request goes through the
  pinned transport with `User-Agent: vaultgate/<version>`, the policy timeout and a body read
  capped at `max_output_bytes` plus the scrub guard band. Redirects are returned as results
  unless `follow_redirects` is on, then at most two hops and only under `base_url` (the same
  origin, so the same pinned address, never a second resolution), with Fetch's method rules.
  The result carries the status, the policy's response headers, the body as text or as base64
  (`body_encoding`) when the media type is not textual or the bytes are not UTF-8, the bytes
  received, `truncated` and `duration_ms`; a non-2xx status, `401` included, is a normal result,
  and only an unreachable destination is an error (`connection_failed`, `tls_error`, `timeout`,
  `destination_refused`, with the error code as the only detail). Contract tests run the
  connector against a fake transport for every policy reason, error code, redirect case, the cap
  with a value straddling the cut, the timeout and each injection mode, plus the ACT-53 canary
  suite through the engine and a confirmed `POST` through the MCP client SDK. A `graph` mapping
  is refused at save with "the graph adapter arrives in M10", and a stored target is validated
  against the connector's save-time rules again on read, so no half-implemented mode can run.
  Operator guide: `docs/guides/actions.md` ("Calling an `http` target"); tool reference:
  `docs/guides/tools-and-scopes.md`.
- Account-page Actions section (spec 13 §13.3.2, M9 third pull request; ACT-5, ACT-6, ACT-8,
  ACT-9, ACT-49, ACT-62, ACT-63 basic): present only with `VAULTGATE_ENABLE_ACTIONS=true`, it
  lists every target with its connector, destination summary, state (a stored row that fails its
  schema is marked `target_invalid` with the reason, ACT-1), grants, last call and open sessions,
  and links to a page per target and to a create form per connector. The forms are drawn from
  per-connector field descriptors over the connector's zod schemas (`http` now: base URL,
  `internal`, the vault item id with its name shown once saved, the injection mode and its
  fields including the `graph` adapter document, the policy allowlists one pattern per line, the
  common limits with their defaults and ceilings; `confirm_writes` is on for every new target);
  a rejected save re-renders with every problem and the submitted values. Edit, enable,
  disable, delete, grant management among the clients holding a consent, "close sessions" and
  the last 50 calls live on the target's page; every write is `POST /account/actions/*` behind
  the ID-18 checks and the five-minute re-authentication window, and every change goes through
  the targets service so its `actions.*` event is recorded (`sessions_closed` is new). The
  account-page audit export offers the `actions` stream beside `audit`. Operator guide:
  `docs/guides/actions.md`.

- Actions engine core (spec 13, M9 first pull request; ACT-1…ACT-74 as far as the engine
  enforces them), off by default behind `VAULTGATE_ENABLE_ACTIONS` with one switch per connector
  (`VAULTGATE_ACTIONS_ENABLE_{HTTP,SQL,SSH,WINRM,BROWSER}`, `VAULTGATE_ACTIONS_BROWSER_CDP_URL`,
  `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND`; a connector switch without the master switch is a
  start-up warning): the six `actions:*` scopes in the registry, advertised and effective only
  when the layer and the connector are on, with the consent-page group and its warning lines;
  migration `004-actions` (`action_targets`, `action_grants`, `action_calls`, `action_sessions`)
  and the maintenance rules that close expired sessions as `idle` and retire calls past audit
  retention; the targets service (create, edit, enable, disable, delete, grant, revoke, consent
  revocation callback) with save-time destination resolution, vault item and field checks and
  `actions.*` audit events; the glob-like policy matcher and HTTP subject normalisation; the
  confirmation `requestState` (HKDF-derived HMAC, 120 s, single-use nonce) and the ACT-42
  elicitation document; the scrubber over every encoded variant with the guard band; per-target
  and per-client limits; the engine (`createActionsEngine`: `listTargets`, `call`) with the
  ACT-16 order, one error code per failure and one `action_calls` row plus one audit event per
  call; `node dist/cli.js audit export --stream actions`; the dependency-cruiser rules for the
  `actions` layer; and the `http` connector's document schemas (including the `graph` adapter
  document). No MCP tool, account page or connector runtime yet: those are the next pull
  requests. Test support gains an echo connector whose fake destination returns its request, so
  the canary suite proves end to end that no injected value, in any encoding, reaches a result,
  an audit row, a log line or an elicitation message.
- Actions MCP surface (spec 13 §13.6 and §13.8, M9 second pull request): `actions_list_targets`
  (ACT-19) and the generic registration every connector tool uses. A connector declares each of
  its tools (name, scope, LLM-facing description, the 13.6.1 annotations, operation schema and
  strict result schema) on its `Connector`; `src/mcp/tools/actions.ts` advertises the tools of
  the loaded connectors with `target` first and dispatches every call to the engine, which
  records the one MCP-13 event itself. `tools/list` shows an actions tool only to a token whose
  effective scopes reach it, so a `vault:read`-only token sees none; `actions_list_targets`
  opens to any enabled `actions:*` scope and its OAUTH-33 challenge lists them all as one
  any-of set. `ToolAnnotations.openWorldHint` is a boolean (ACT-18). On the 2026-07-28 wire a
  confirmed target answers a form-capable client with the ACT-42 elicitation document as the
  SDK's `input_required` result and honours the retried answer (ACT-45…47); a client that
  declares no form-mode elicitation is refused with the fixed ACT-48 message before anything
  else happens, and a 2025-wire client counts as one until M14's in-band fallback. Revoking a
  client's consent on the account page now revokes its grants and closes its sessions (ACT-10)
  through a callback the composition layer wires into the authorization server. No connector
  runtime yet: `http_request` is declared by the `http` connector when it lands, so no
  connector tool is listed on any deployment until then.

### Changed

- The pinned transport (`src/net/pinned-https.ts`) serves every method, a request body, and
  plain `http://` through `node:http` beside `https://`, still connecting only to the address the
  caller validated; `createPinnedHttpsFetch` takes `{ https, http }` request functions and
  `readBodyCapped` reads a response up to a limit and cancels the rest. The CIMD fetcher's
  behaviour is unchanged.
- The connector interface's `authorize` receives the credential document as a third argument,
  so a connector can refuse the header its mapping injects (ACT-22). `validateTarget` runs the
  connector's pure save-time problems again on read (ACT-1), marking such a row `invalid`.
- One version source: `src/version.ts` reads `package.json`, and both the MCP `initialize`
  response (previously a hand-kept `0.1.0`) and the actions `User-Agent` report it.
- One in-memory limiter module, `src/net/rate-limit.ts`, serves the authorization server, the
  MCP endpoint and the actions engine; `src/oauth/rate-limit.ts` and `src/mcp/rate-limit.ts` are
  gone. A token bucket now remembers the budget it was taken under, so a key with its own limit
  (a target's `rate_limit_per_minute`) is never judged full against the limiter's default.
- `src/oauth/ip-ranges.ts` moved to `src/net/ip-ranges.ts` and gained `classifyAddress`
  (`public`, `private`, `forbidden`, `invalid`) and the `Lookup` type; `isPublicAddress` and the
  CIMD fetcher are unchanged.
- The audit keyset pagination and streaming export are shared by both streams
  (`src/audit/keyset.ts`, `lineFormats`); `listAuditEvents` returns `records`.
- `parseSecretField` lives in `src/vault/fields.ts` with the field-presence check ACT-4 needs;
  `deriveKey` is exported from `src/crypto/secret-box.ts` for the confirmation HMAC purpose.

### Docs

- ADR 0007 and spec sections 13 (Actions) and 14 (Action connectors) specify a planned,
  off-by-default actions layer: operator-defined targets, six `actions:*` scopes, typed tools
  (`http_request` with a Microsoft Graph adapter, `sql_query`/`sql_execute`, `ssh_run`,
  `winrm_run`, `browser_*` over a Chromium sidecar), operator allowlist policy, MCP tool
  annotations, per-call confirmation through MCP elicitation, scrubbing of every injected value,
  `action_*` tables and audit. ADR 0004 is marked amended by 0007; the threat model gains
  T24…T34 and the residual risks of the layer; `PLAN.md` gains M9…M15 with exit criteria; the
  tools guide, README and section 01 principle 3 note the layer as planned. No code changes.

### Fixed

- VAULT-16: a `bw serve` call that vaultgate aborted at the 60 s bound carried the same message
  as a refused or reset connection (`the vault is locked or not reachable`), so a `vault backend
  start failed` line could not say whether the child had stalled or was gone. The abort now reads
  `the vault did not answer within 60 s`; the code is still `vault_unavailable`. Spec VAULT-6
  states that a `/unlock` which is refused, reset or times out is a failed attempt, restarted on
  the same generation without a second login.
- Integration suite: the readiness wait gave up silently at 90 s, so a first `/unlock` that hit the
  VAULT-16 bound (the restart a second later was ready) failed `VAULT-4 VAULT-5` with
  `expected false to be true` while the rest of the suite passed. The wait now covers one failed
  attempt and a clean restart (150 s, `hookTimeout` 180 s), fails the hook with the reason, and the
  supervisor logs at `info` so a run shows when the CLI logged in, synced and became ready.

## [0.1.0-rc.5] - 2026-09-23

### Security

- OAUTH-8, T6: the CIMD fetcher no longer resolves a host name twice. It validates every
  address the name maps to, then connects to that address through a `node:https` transport
  (`src/net/pinned-https.ts`) whose `lookup` answers with the validated address only, so a name
  that changes its answer between check and connect (DNS rebinding) gains nothing; the name still
  selects the TLS server and the `Host` header, and every redirect hop is resolved and pinned
  afresh. No dependency was added.
- OPS-6: behind a trusted proxy the client address is the `X-Forwarded-For` entry
  `VAULTGATE_TRUSTED_PROXY_HOPS` (new, default `1`, `1`–`10`) from the right, the one the proxy
  wrote, instead of the leftmost entry, which any client could set. Everything to its left is
  ignored, an entry that is not an IP literal falls back to the socket address, and both the
  identity guards and `/mcp` share the one helper (`src/net/client-ip.ts`). The shipped Caddy and
  nginx snippets overwrite the inbound header rather than appending to it.
- §10.4: anonymous `/oauth/authorize` requests are rate limited by client address, not by the
  client-chosen `vg_authz` cookie, so rotating the cookie no longer buys a fresh allowance; a
  signed-in browser is still limited by its session. Every in-memory limiter now holds at most
  10 000 keys, evicting the least recently used, and prunes a few cold entries per call instead
  of scanning every entry.
- OAUTH-29: `POST /oauth/revoke` is rate limited like the token endpoint (60 requests per IP per
  minute, `429` with `Retry-After`).
- OPS-4: `/readyz` no longer discloses whether vault credentials are configured or when the vault
  last synced to anonymous callers. The public answer is `status` and `failing`; the `vault`
  detail is included only when an operator session cookie accompanies the request, and the
  account page shows the same.
- OAUTH-25: `grant_type=refresh_token` requires `client_id` (OAuth 2.1 §3.2.2) and binds the
  refresh token to it exactly as the code grant does; a missing `client_id` is
  `invalid_request`, a different one `invalid_grant`. Previously an omitted `client_id` skipped
  the binding check.

### Changed

- The pinned transport (`src/net/pinned-https.ts`) serves every method, a request body, and
  plain `http://` through `node:http` beside `https://`, still connecting only to the address the
  caller validated; `createPinnedHttpsFetch` takes `{ https, http }` request functions and
  `readBodyCapped` reads a response up to a limit and cancels the rest. The CIMD fetcher's
  behaviour is unchanged.
- The connector interface's `authorize` receives the credential document as a third argument,
  so a connector can refuse the header its mapping injects (ACT-22). `validateTarget` runs the
  connector's pure save-time problems again on read (ACT-1), marking such a row `invalid`.
- One version source: `src/version.ts` reads `package.json`, and both the MCP `initialize`
  response (previously a hand-kept `0.1.0`) and the actions `User-Agent` report it.
- One scope registry (`src/scopes/registry.ts`) and one bearer-token contract
  (`src/auth/token-types.ts`) sit below both the authorization server and the MCP resource
  server, replacing the duplicated copies and the test that held them in step; the
  dependency-cruiser layering lists both as foundation modules and no longer needs a type-only
  door from `oauth/` to `mcp/`. `TokenVerifier.verify` may answer synchronously.
- `main.ts` builds the ID-18 guards first and composes the authorization server before identity,
  so the account page's connected-clients renderer is passed in directly instead of through a
  mutable slot; `createIdentity` takes `guards`. The milestone banner comments are gone from
  `main.ts` and `src/http/app.ts`.
- Dead code removed: `RejectAllTokenVerifier`, `UnavailableVaultClient`, `formatScopes`,
  `commonPasswordCount`, `SCOPES_SUPPORTED` and `PINNED_BW_VERSION` (the Dockerfile and
  `install.sh` pins are now compared with each other and with the minimum); `base32Decode` and
  `totp` moved to test support, which is the only place that decodes or generates.
  `npm run knip` also runs knip in production mode, so an export only a test consumes is reported.
- `Promise.resolve` wrappers that existed only to satisfy `require-await` are gone from the
  consent-page handler, the `/mcp` guard middleware, the local identity provider and the
  store-backed token verifier.
- The integration suite skips, with the condition in its title, when no `VAULTGATE_TEST_BW_*`
  credential is set (a partial set still fails), so a bare `vitest run` passes.

### Docs

- `docs/reviews/`: the independent security review and code review of v0.1.0-rc.4, reproduced
  verbatim.
- README quick start (version, Compose steps, first run, what the operator password is and is
  not, the bundled `bw` CLI, stored connections surviving restarts) and a root `llms.txt`.
- `install.sh` guide shows the download-then-inspect path before the piped one-liner; the nginx
  snippet explains the `/mcp` read timeout.
- `VAULTGATE_TRUSTED_PROXY_HOPS` appears in `.env.example` and the systemd `vaultgate.env.example`
  with its meaning on one line.
- `src/config.ts` is `src/config/` in the specification, `CONTRIBUTING.md` and the ESLint
  message; ADR 0006 records `src/cli.ts` as the second coverage exclusion; COMPAT-1 describes
  where the CLI version is pinned; the source layout lists `scopes/`, `auth/`, `crypto/` and
  `vault/`.

## [0.1.0-rc.4] - 2026-09-23

### Added

- ID-25, VAULT-18, STORE-9: the Bitwarden connection (server, API key client id and secret,
  master password) is set and changed from the account page's new **Vault connection** section,
  behind re-authentication, without editing environment variables or restarting. Saving stores
  the connection encrypted under `VAULTGATE_SECRET_KEY` (schema v3, `vault_settings`; distinct
  HKDF purposes for the two secrets) and switches the running backend to it: the old `bw serve`
  is locked and stopped, the new credentials log in inside a fresh CLI app-data generation
  (`${DATA_DIR}/bw/<n>`, so no session is ever reused and `bw logout` is still never called),
  and the retired generation is deleted once the new one is unlocked. A failure restores the
  previous connection (or the unconfigured state) and the previous stored row, and shows one
  fixed reason; secrets are never echoed, logged or audited. Blank secret fields keep the values
  in use, so a rotated master password or API key is a single save. The section shows the
  configured state, its source, the server, the masked account e-mail, readiness and the last
  sync; the first-run recovery-codes page links to it while nothing is connected; every attempt is
  the audit event `vault.settings_updated`.
- `/readyz` reports `vault.configured`, so an unconfigured deployment reads differently from a
  failing one.

### Changed

- The pinned transport (`src/net/pinned-https.ts`) serves every method, a request body, and
  plain `http://` through `node:http` beside `https://`, still connecting only to the address the
  caller validated; `createPinnedHttpsFetch` takes `{ https, http }` request functions and
  `readBodyCapped` reads a response up to a limit and cancels the rest. The CIMD fetcher's
  behaviour is unchanged.
- The connector interface's `authorize` receives the credential document as a third argument,
  so a connector can refuse the header its mapping injects (ACT-22). `validateTarget` runs the
  connector's pure save-time problems again on read (ACT-1), marking such a row `invalid`.
- One version source: `src/version.ts` reads `package.json`, and both the MCP `initialize`
  response (previously a hand-kept `0.1.0`) and the actions `User-Agent` report it.
- ID-3, ID-12: the operator is identified by e-mail address instead of a display name. Setup asks
  for e-mail address, password and authenticator code; login asks for e-mail address and
  password, then the second factor. The address is trimmed, lower-cased and shape-checked only
  (no mail is sent), can be changed from the account page after confirming the password
  (`POST /account/email`), and appears as `details.email` on the setup, login and address-change
  audit events. Login throttling (ID-13) counts the account by the submitted address. The
  `operator-email` migration adds `operators.email` with a case-insensitive unique index and
  deprecates `display_name`.
- ID-26: an account created before that migration keeps working. Its login page asks for the password
  alone, and the account page is replaced by a "Set your e-mail address" page (re-authentication
  first) until an address is set; every other account action is refused meanwhile.

**Upgrading note for scripted setups and runbooks:** the `POST /setup` and `POST /login` form
field `display_name` is gone; send `email` instead.

- CFG-5: `VAULTGATE_BW_PASSWORD`, `VAULTGATE_BW_CLIENT_ID` and `VAULTGATE_BW_CLIENT_SECRET` are
  optional. They seed the first boot when all three are set and are ignored once a connection has
  been saved on the account page; a partial set is logged and ignored. The backend starts
  unconfigured without them (no process is spawned; tool calls answer `vault_unavailable`).
  `install.sh` no longer waits for them, the Compose secret files may be empty (an empty `_FILE`
  now means unset, CFG-1), the Azure template's three Bitwarden parameters default to empty and
  create their Key Vault secrets only when supplied, and the smoke scripts boot without them.
- VAULT-3: before a login, a reused CLI directory that still names a server is reset with
  `bw config server bitwarden.com` when the connection names none.
- VAULT-1: the CLI app-data directory is `${DATA_DIR}/bw/<n>` per credential generation instead
  of `${DATA_DIR}/bw`. An existing `${DATA_DIR}/bw` directory is left untouched and unused; the
  first start after upgrading logs in afresh under `bw/1`.
- The secret box moved to `src/crypto/secret-box.ts` (a foundation module) so the vault backend
  can seal its settings without depending on the identity module.

### Fixed

- ID-23: opening the bare site root answered the JSON `{"error":"not_found"}`. `GET /` now
  redirects (`303`) to `/account` when an operator session is present and to `/login` otherwise.
- ID-19: the sessions and connected-clients tables on `/account` needed horizontal scrolling on a
  phone. Every table cell now carries its column heading in `data-label`, and at 640px and below
  the stylesheet stacks each row into a labelled card with full-width buttons; inputs, selects
  and preformatted text are capped at the page width, form controls are at least 44px tall on
  small or touch screens, and the `select` inherits the 16px page font so mobile browsers do not
  zoom. The desktop layout is unchanged. Still CSS only: the pages ship no JavaScript.
- ID-24: an unknown path requested by a browser (an `Accept` header preferring `text/html`) is
  answered with a short HTML page under the ID-19 policy; API clients (JSON accepted, `*/*`, or no
  `Accept`) still receive the JSON body. `/mcp` and the well-known routes are unchanged.

### Docs

- The README "Why" section leads with the claim the design rests on, that the agent never holds
  your credentials, and compares vaultgate with the official `bitwarden/mcp-server`, warden-mcp's
  remote mode and the typical community servers on where it runs, who holds the master password,
  client authorization, consent and scopes, revocation and audit trail. `docs/comparison.md` is
  the long form with dated verification notes and the cases where the official stdio server is
  the better choice. `docs/adoption.md` lists the registries, channels and app stores with the
  submission mechanics of each.
- `server.json` is the MCP Registry listing (`io.github.adamrowles1996/vaultgate`, a
  `streamable-http` remote at `https://{host}/mcp` with `host` as a variable, because every
  operator's URL is different). `docs/guides/publishing.md` explains `mcp-publisher`. Nothing is
  published automatically.

## [0.1.0-rc.3] - 2026-09-23

### Fixed

- VAULT-6: a `bw serve` that died after the vault was ready reset the failure count on every
  restart, so a child crashing on each scheduled sync restarted every few seconds with
  `attempt: 1` and never reached the backoff or the `error`-level escalation. The count is now
  cleared only after five minutes of readiness; an earlier exit is one more consecutive failure.
- VAULT-6: the child's stdout and stderr were discarded, so the reason for an exit was never
  logged. The last 40 lines (at most 4 KiB) are kept and logged on `bw serve exited` with the
  exit code, signal and uptime, after session keys (`BW_SESSION=…`, long base64 tokens) and
  password assignments are redacted.
- VAULT-9: successful syncs, the initial one included, are logged at `info` as `vault synced` with
  their duration, and `/readyz` reports `vault: { ready, lastSyncAt }` beside `failing`; the
  status semantics are unchanged.
- VAULT-17: a `/sync` answered without its JSON envelope while `bw serve` is still running is
  retried once after 2 s before it is reported, and a sync that fails because the child exited is
  not counted as a second failure.

## [0.1.0-rc.2] - 2026-09-23

### Fixed

- Azure template: `VAULTGATE_ENABLE_WRITE_SCOPE` is rendered as `true`/`false` (ARM `string()` produced
  `True`, which the configuration schema rejects, so the container crash-looped).
- DEP-4: `install.sh` no longer sources `/etc/os-release`, whose `VERSION` field replaced the
  release chosen with `--version` and produced a download URL such as `vaultgate 24.04.5 LTS`; the
  version check is now strict (`X.Y.Z` or `X.Y.Z-rc.N`) and `scripts/test-install-sh.sh` drives the
  installer's argument, operating-system and package logic against a fake os-release in CI.
- DEP-5: the installer adds `libatomic1` to the apt list (Node 26 needs it and Ubuntu 24.04 cloud
  images omit it) and runs `node --version` and `bw --version` once after installing each binary,
  stopping on failure instead of hiding it inside an info line. The `bw --version` probe points the
  CLI's app data at the scratch directory, so nothing is written under `/root/.config`.
- DEP-4: `_FILE` secrets are read by the service user, not root. The installer now creates
  `/etc/vaultgate` as 0750 `root:vaultgate` and `/etc/vaultgate/secrets` as 0700
  `vaultgate:vaultgate`, and the environment example and guides show writing each secret with
  `install -m 0600 -o vaultgate`. `VAULTGATE_BW_CLIENT_ID` is documented as having no `_FILE` form.
- VAULT-6: right after a cold start, `bw serve` can accept connections before its handlers are
  ready and answer `/unlock` with something other than its JSON envelope, which was logged as a
  failed start and retried after the backoff. The supervisor now retries the unlock every 250 ms for
  up to 10 s after spawning the child before counting a protocol error as a failure.
- VAULT-16: every `bw serve` call is bounded to 60 s and aborted with `vault_unavailable` when it
  outlives that, so a `bw serve` that stops answering can no longer leave an MCP request hanging
  with nothing logged. A regression test drives `POST /mcp` with an operator session cookie beside
  the bearer token, which was reported as a stall and is answered normally.
- ID-15: revoking a connected client from the account page now needs a password confirmation
  within the last five minutes, like every other sensitive action; the Disconnect buttons appear
  only inside that window and the page points at the re-authentication form until then.
- OAUTH-37: CORS preflight on `/mcp`, the well-known documents and the OAuth machine routes now
  allows the `Mcp-Method` and `Mcp-Name` request headers of the 2026-07-28 wire format.
- VAULT-13: `list_folders` no longer returns the `No Folder` pseudo-folder, whose id current
  Bitwarden CLIs report as an empty string rather than `null`; the `bw serve` double now emits the
  real shape.
- VAULT-7: shutdown logs `vault locked` and `bw serve stopped` (and `vault lock failed` when the
  lock is refused) instead of stopping silently.
- OAUTH-1, OAUTH-2: `scopes_supported` lists the scopes in the same order in the protected
  resource and authorization server metadata (`vault:read`, `vault:reveal`, `vault:generate`,
  `vault:write`).

### Added

- MCP protocol coverage: the in-process test client speaks both `2025-11-25` and `2026-07-28`
  (per-request `_meta` envelope, `Mcp-Method` and `Mcp-Name` headers), and the `/mcp` tests run
  `initialize`, `tools/list`, `tools/call` and the scope gate under both.

## [0.1.0-rc.1] - 2026-09-22

### Added

- OAuth 2.1 authorization server (spec §03, milestone M3): RFC 8414 metadata, client resolution
  (pre-registered, CIMD with an SSRF-safe fetcher and bounded cache, RFC 7591 registration of
  public clients), the authorize endpoint with server-side pending requests bound to the browser,
  the consent page (client name, redirect host, registration mechanism, loopback warning, per-scope
  explanations and risk markers), single-use PKCE-bound authorization codes with `iss`, the token
  endpoint (authorization code and rotating refresh tokens with family revocation, `invalid_grant`
  on replay), RFC 7009 revocation, consent revocation from the account page, per-surface rate limits
  and a store-backed bearer verifier for the MCP resource server. Contract tests drive the real
  application with `@modelcontextprotocol/client`'s OAuth helpers for all three registration paths.
- Project scaffold: TypeScript on Node 26, strict lint and type gates, 100% coverage gate,
  file-size and commit-subject gates, pinned CI with CodeQL, Scorecard and Dependabot.
- Repository-wide gates: actionlint, shellcheck and shfmt, markdownlint, cspell (en-GB),
  eslint-plugin-regexp, eslint-plugin-n, eslint-plugin-unicorn, @vitest/eslint-plugin,
  dependency-cruiser layering rules, lockfile-lint, sort-package-json, editorconfig-checker,
  gitleaks and `npm audit signatures`, with non-npm tools pinned in `.mise.toml`.
- Minimal server with validated configuration, redacting logger and health probes.
- Full configuration schema (spec §08): every variable validated in one pass, `_FILE` variants
  for secrets with permission warnings, duration and URL rules, and a masked start-up summary.
- Specification (`docs/spec/`), delivery plan, threat model and initial ADRs.
- Vault backend (spec §05): a supervised loopback `bw serve` with version gate, API-key login,
  unlock, scheduled sync, exponential-backoff restart and lock-then-stop shutdown; a
  zod-validated `BwServeVaultClient` with read-after-write consistency and secret-free error
  mapping; an in-process `bw serve` double and an opt-in integration suite
  (`npm run test:integration`). `/readyz` now names the vault until it is unlocked.
- Packaging (spec §09): a multi-stage container image on digest-pinned `node:26-bookworm-slim`
  with the Bitwarden CLI pinned by version and SHA-256 per architecture, a non-root user and a
  curl-free health check; `docker-compose.yml` with Caddy, file-mounted secrets and a read-only,
  capability-free container; Caddy and nginx snippets in `deploy/proxy/`; `install.sh` for
  Debian and Ubuntu with checksum-verified Node, CLI and release tarball and a hardened systemd
  unit; a tag-driven release workflow that publishes the signed multi-arch image with SBOM and
  provenance and a GitHub release with `vaultgate-<version>.tgz` and its `.sha256`; a hadolint
  gate and a pull-request image build.
- Storage (spec §07): the SQLite store on `node:sqlite` with the STORE-2 pragmas (network
  filesystem mode included), a `0600` database file, the checksummed forward-only migration
  runner that refuses a changed or newer schema, the v1 schema with its hot-path indexes, typed
  query helpers, and the hourly retention task; `/readyz` now reports the store and answers
  `503` with the failing components.
- Identity (spec §04): first-run bootstrap token and `/setup`, the operator account with scrypt
  password hashing (parameter upgrade on login) and a bundled 10 000 common-password list, RFC 6238
  TOTP on `node:crypto` verified against the RFC vectors with replay protection, TOTP secrets sealed
  with HKDF + AES-256-GCM under `VAULTGATE_SECRET_KEY`, eight single-use recovery codes, hashed
  sessions with `__Host-` cookies, idle and absolute expiry and rotation on login, Origin plus
  synchroniser-token CSRF checks, exponential login backoff without lockout, server-rendered
  `/login`, `/logout` and `/account` pages under a strict CSP with a single stylesheet, HSTS, and
  the `IdentityProvider` interface the authorization server consumes.
- Azure Container Apps deployment (spec §09.3): `deploy/azure/` ARM template with linked
  modules (Log Analytics, Container Apps environment, Key Vault with RBAC and purge protection,
  Azure Files share at `/data`, single-replica Container App with Key Vault secret references),
  a portal form with a Deploy to Azure button, a README covering custom domains and first-run
  bootstrap, and an ARM-TTK template validation job in CI.
- Audit trail (spec §06.4, §10.3): one `AuditEvent` shape for identity, OAuth and MCP events
  (`src/audit/event.ts`), the append-only `StoreAuditSink` that writes every event to
  `audit_events` inside the request, drops any credential-named detail key and logs rather than
  raises a failed write; keyset-paginated listing and JSON Lines or RFC 4180 CSV export as a
  stream; the re-authentication-gated "Audit log" download on the account page
  (`POST /account/audit/export`); and `node dist/cli.js audit export --from --to [--format csv]`
  over a read-only store, with a CI smoke step (`scripts/cli-smoke.sh`) that exports an empty
  store from both the build and the source.

[Unreleased]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.7...HEAD
[0.1.0-rc.7]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.6...v0.1.0-rc.7
[0.1.0-rc.6]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.5...v0.1.0-rc.6
[0.1.0-rc.5]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.3...v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/adamrowles1996/vaultgate/releases/tag/v0.1.0-rc.1
