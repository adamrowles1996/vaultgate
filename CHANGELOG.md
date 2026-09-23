# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.2...HEAD
[0.1.0-rc.2]: https://github.com/adamrowles1996/vaultgate/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/adamrowles1996/vaultgate/releases/tag/v0.1.0-rc.1
