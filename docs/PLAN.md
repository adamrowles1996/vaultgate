# Delivery plan

The specification in `docs/spec/` is delivered in the milestones below. Each
milestone is one or more pull requests; every pull request leaves `main`
releasable: green CI, 100% coverage, documentation updated, changelog entry.

## Principles

- **One logical change per pull request.** A PR that touches OAuth and the vault client is two PRs.
- **Vertical, not horizontal.** A milestone ships a working slice (for example "the full
  authorization handshake against a stub resource") rather than "all the models".
- **Tests carry the requirement id.** A test named `OAUTH-22 reuse of a consumed code revokes the
tokens it issued` is the traceability.
- **Nothing lands without its docs.** The spec is normative; if implementation reveals it is
  wrong, the PR changes the spec and says why.

## Milestones

### M0 Scaffold ✅ (this repository's first commit)

- Repository, licence, governance files, CI with pinned actions, CodeQL, Scorecard, Dependabot.
- Toolchain: Node 24, TypeScript 5.9 strict, ESLint 10 type-checked, Prettier, knip, vitest at
  100%, file-size and commit-subject gates, git hooks.
- Minimal runnable server: config, logger with redaction, Hono app with health probes, smoke test.
- The specification, this plan, the threat model and the first ADRs.

Exit: CI green on `main`; branch protection on; repository settings applied (see 11.4).

### M1 Store and configuration (spec 07, 08)

1. `feat(config)`: full environment schema with `_FILE` variants, durations, secret masking (CFG-1…4).
2. `feat(storage)`: `node:sqlite` connection, pragmas, migration runner with checksums, v1 schema,
   repositories with typed row mappers, maintenance task (STORE-1…6).
3. `feat(audit)`: append-only writer and query API (MCP-13…15 data path).

Exit: migrations apply on an empty directory and are idempotent; repository tests run against a
temporary database; maintenance deletes exactly the expired rows.

### M2 Identity (spec 04)

1. `feat(identity)`: scrypt password hashing with parameter upgrade, common-password list, TOTP
   with RFC vectors, recovery codes, encrypted secret storage under `VAULTGATE_SECRET_KEY`.
2. `feat(identity)`: sessions, cookie handling, CSRF, rate limiting and backoff.
3. `feat(identity)`: bootstrap flow (`/setup`), login and logout pages, account page skeleton,
   static stylesheet, CSP.

Exit: a browser (Playwright, headless, in CI) can complete setup → logout → login with TOTP →
re-authentication; every negative path in 04 is covered.

### M3 Authorization server (spec 03)

1. `feat(oauth)`: metadata documents, scope registry, CORS policy (OAUTH-1…4, 36, 37).
2. `feat(oauth)`: client resolution: pre-registered, DCR endpoint, CIMD fetcher with SSRF guard
   and cache (OAUTH-5…13).
3. `feat(oauth)`: authorize endpoint, pending-authorization storage, consent page, code issuance
   with `iss` (OAUTH-14…20).
4. `feat(oauth)`: token endpoint (code and refresh grants), rotation and family revocation,
   revocation endpoint (OAUTH-21…30).

Exit: contract tests drive the complete handshake using `@modelcontextprotocol/client`'s OAuth
helpers against the in-process app for all three registration paths; a stub resource returns the
verified `AuthInfo`.

### M4 MCP resource server with a fake vault (spec 06)

1. `feat(mcp)`: bearer verifier, `WWW-Authenticate` challenges, scope gate, stateless
   `createMcpHandler` wiring, origin/host validation, body cap, per-token rate limit (OAUTH-31…35,
   MCP-1…5).
2. `feat(mcp)`: `VaultClient` interface and `InMemoryVaultClient`; read tools, generate tools,
   `get_secret`, write tools with schemas and descriptions (MCP-6…12).
3. `feat(mcp)`: audit events for tool calls and auth events; canary containment tests (MCP-13…15).

Exit: an MCP Inspector CLI run in CI lists tools, calls `search_items` and receives a 403
challenge for `get_secret` with a `vault:read`-only token.

### M5 Real vault backend (spec 05)

1. `feat(bitwarden)`: `serve-process` spawn boundary, port selection, environment scrubbing,
   login/unlock, restart with backoff, shutdown (VAULT-1…8).
2. `feat(bitwarden)`: `BwServeVaultClient` with zod-validated responses, sync scheduler,
   read-after-write polling, error mapping (VAULT-9…15).
3. `test(bitwarden)`: an HTTP double of `bw serve` in `src/test-support/` so the client is fully
   covered without the binary; an opt-in integration test against a real CLI and a throwaway
   Vaultwarden container (CI job on a schedule, not on PRs).

Exit: `/readyz` reflects the real unlock state; the compatibility suite passes against
Vaultwarden.

### M6 Packaging (spec 09.1, 09.2, 09.4)

1. `build(docker)`: multi-stage Dockerfile with pinned, checksummed `bw`, non-root, read-only
   rootfs, healthcheck; `docker-compose.yml` with Caddy; `deploy/proxy/` snippets.
2. `build(install)`: `install.sh` with checksum verification and the hardened systemd unit.
3. `ci(release)`: tag-driven multi-arch build, cosign signing, SBOM, provenance, GitHub release.

Exit: `docker compose up` on a clean VM reaches the setup page over HTTPS; the release workflow
publishes `v0.1.0-rc.1`.

### M7 Azure (spec 09.3)

1. `feat(azure)`: `mainTemplate.json`, `createUiDefinition.json`, parameters file, README with
   the Deploy to Azure button; ARM-TTK in CI.
2. `ci(azure)`: `what-if` job against a sandbox subscription on release candidates (manual
   approval environment).

Exit: a real deployment from the button reaches the setup page on the generated
`*.azurecontainerapps.io` host and completes a Claude connector handshake.

### M8 Compatibility, hardening, documentation

1. Compatibility suite evidence for Claude web/desktop/Cowork, Claude Code, Codex, Inspector.
2. Threat-model review against the implementation; fuzz the token and authorize parsers
   (property-based tests); dependency and licence audit.
3. User documentation: `docs/guides/` (connect Claude, connect Codex, self-hosted Bitwarden,
   Vaultwarden, backups, upgrading), architecture diagram, FAQ.

Exit: `v1.0.0`.

### Post-1.0 candidates

- Passkey (WebAuthn) operator login.
- Upstream OIDC operator login.
- PostgreSQL store for multi-replica deployments.
- Prometheus metrics.
- Organisation collections filtering and per-client item allowlists.

## Inputs needed from the maintainer

| Item                                                                                                       | Needed by |
| ---------------------------------------------------------------------------------------------------------- | --------- |
| A public hostname for the reference deployment                                                             | M6        |
| A dedicated Bitwarden (or Vaultwarden) test account and personal API key for the scheduled integration job | M5        |
| An Azure sandbox subscription and service principal for `what-if` runs                                     | M7        |
| Decision on the default `VAULTGATE_ACCESS_TOKEN_TTL` for hosted agents (1 h proposed)                      | M3        |

## Risks

| Risk                                                      | Mitigation                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| SDK v2 is new (2.0.0); API churn                          | Pin exactly; isolate SDK usage behind `src/mcp/server.ts`; Dependabot PRs run the contract tests.                        |
| `bw serve` behaviour changes between CLI versions         | Minimum version gate; scheduled integration job against the latest CLI; the HTTP double encodes the contract we rely on. |
| SQLite on Azure Files                                     | Single replica, rollback journal, exclusive locking; documented; PostgreSQL store post-1.0.                              |
| Hosted clients change registration behaviour (DCR → CIMD) | Both supported; compatibility suite per release.                                                                         |
| Scope creep toward organisation administration            | Non-goals are written down; requests go to post-1.0 candidates.                                                          |
