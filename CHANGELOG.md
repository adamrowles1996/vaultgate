# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.5...HEAD
[0.1.0-rc.5]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.3...v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/adamrowles1996/vaultgate/releases/tag/v0.1.0-rc.1
