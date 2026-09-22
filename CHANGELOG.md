# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/adamrowles1996/vaultgate/commits/main
