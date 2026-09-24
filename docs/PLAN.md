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
- Toolchain: Node 26, TypeScript 5.9 strict, ESLint 10 type-checked, Prettier, knip, vitest at
  100%, file-size and commit-subject gates, git hooks.
- Minimal runnable server: config, logger with redaction, Hono app with health probes, smoke test.
- The specification, this plan, the threat model and the first ADRs.

Exit: CI green on `main`; branch protection on; repository settings applied (see 11.4).

### M1 Store and configuration (spec 07, 08) ✅

1. `feat(config)`: full environment schema with `_FILE` variants, durations, URL rules, secret
   masking for the start-up summary (CFG-1…4).
2. `feat(storage)`: `node:sqlite` connection, pragmas, migration runner with checksums, the v1
   schema, and the hourly maintenance task (STORE-1…6). Repositories land with their first
   consumer in M2 and M3 so no code is dead on arrival; the audit writer lands with the first
   audited event (login) in M2.

Exit: migrations apply on an empty directory and are idempotent; the maintenance task deletes
exactly the expired rows; the server boots with a full configuration and reports it masked.

### M2 Identity (spec 04) ✅

1. `feat(identity)`: scrypt password hashing with parameter upgrade, common-password list, TOTP
   with RFC vectors, recovery codes, encrypted secret storage under `VAULTGATE_SECRET_KEY`.
2. `feat(identity)`: sessions, cookie handling, CSRF, rate limiting and backoff.
3. `feat(identity)`: bootstrap flow (`/setup`), login and logout pages, account page skeleton,
   static stylesheet, CSP.

Exit: the in-process browser double (`app.request()` plus a cookie jar) completes setup → logout →
login with TOTP → re-authentication; every negative path in 04 is covered (ID-22).

### M3 Authorization server (spec 03) ✅

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

### M4 MCP resource server with a fake vault (spec 06) ✅

1. `feat(mcp)`: bearer verifier, `WWW-Authenticate` challenges, scope gate, stateless
   `createMcpHandler` wiring, origin/host validation, body cap, per-token rate limit (OAUTH-31…35,
   MCP-1…5).
2. `feat(mcp)`: `VaultClient` interface and `InMemoryVaultClient`; read tools, generate tools,
   `get_secret`, write tools with schemas and descriptions (MCP-6…12).
3. `feat(mcp)`: audit events for tool calls and auth events; canary containment tests (MCP-13…15).

Exit: an MCP Inspector CLI run in CI lists tools, calls `search_items` and receives a 403
challenge for `get_secret` with a `vault:read`-only token.

### M5 Real vault backend (spec 05) ✅

1. `feat(bitwarden)`: `serve-process` spawn boundary, port selection, environment scrubbing,
   login/unlock, restart with backoff, shutdown (VAULT-1…8).
2. `feat(bitwarden)`: `BwServeVaultClient` with zod-validated responses, sync scheduler,
   read-after-write polling, error mapping (VAULT-9…15).
3. `test(bitwarden)`: an HTTP double of `bw serve` in `src/test-support/` so the client is fully
   covered without the binary; an opt-in integration test against a real CLI and a throwaway
   Vaultwarden container (CI job on a schedule, not on PRs).

Exit: `/readyz` reflects the real unlock state; the compatibility suite passes against
Vaultwarden.

### M6 Packaging (spec 09.1, 09.2, 09.4) ✅

1. `build(docker)`: multi-stage Dockerfile with pinned, checksummed `bw`, non-root, read-only
   rootfs, healthcheck; `docker-compose.yml` with Caddy; `deploy/proxy/` snippets.
2. `build(install)`: `install.sh` with checksum verification and the hardened systemd unit.
3. `ci(release)`: tag-driven multi-arch build, cosign signing, SBOM, provenance, GitHub release.

Exit: `docker compose up` on a clean VM (the maintainer's Proxmox host is the reference) reaches
the setup page over HTTPS; `install.sh` completes on a clean Ubuntu LTS VM on the same host; the
release workflow publishes `v0.1.0-rc.1`.

### M7 Azure (spec 09.3) ✅

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

### The actions layer (spec 13, 14; ADR 0007)

Milestones M9 to M15 deliver the typed actions layer. They were planned for after `v1.0.0`; M9 to
M14 landed during the release-candidate series, ahead of M8's exit, because using a credential
without revealing it is what the operator's agents need vaultgate for. Every milestone ships
behind `VAULTGATE_ENABLE_ACTIONS` (and its connector switch) so a release between them changes
nothing for a deployment that has not opted in. Each milestone lands contract tests against
fakes (ACT-75) and records a live test against the maintainer's own systems in its pull request.

### M9 Actions core and `http` (ACT-1…80)

1. `feat(actions)`: the `src/actions/` layer and its dependency-cruiser rules, migration
   `004-actions`, target and grant repositories with per-connector zod schemas, the six
   `actions:*` scopes in the registry (advertised only when enabled), the engine's resolution
   order, pattern matcher, rate limits, scrubber, `action_calls` audit and export stream.
2. `feat(actions)`: account-page Actions section (targets, grants, sessions, call history) behind
   re-authentication; `actions_list_targets`.
3. `feat(actions)`: the `http` connector with `bearer`, `basic`, `header` and `query` injection,
   pinned transport, redirect policy; `http_request`.

Exit: a `vault:read`-only token sees no actions tool; an `actions:http` token calls a granted
target through a fake and a canary credential never appears in any result, log or audit row;
a live call reaches an HTTPS API of the maintainer's with a vault-held API key.

### M10 `graph` credential adapter (ACT-81…83)

1. `feat(actions)`: client-credentials and refresh-token exchange server-side, in-memory token
   cache keyed by target revision, one retry on `401`, refresh-token write-back to the vault with
   its audit event.

Exit: contract tests against a fake token endpoint cover both grants, expiry, rotation and a
failed write-back; a live `GET /v1.0/me` (refresh grant) and `GET /v1.0/users` (client
credentials) succeed against the maintainer's Microsoft 365 tenant.

### M11 `sql`, read then write (ACT-23…26, 36…38, 84…86)

1. `feat(actions)`: tokeniser and classifier with the per-engine corpus (ACT-77); `sql_query`
   over `pg` and `mssql` with read-only sessions where the engine allows; `actions:sql.read`.
2. `feat(actions)`: `sql_execute` with `write_classes`, `statement_allowlist`, per-statement
   transaction; `actions:sql.write`; the elicitation flow of 13.8 (first write tool to need it),
   including the no-elicitation refusal and every `ElicitResult` outcome (ACT-76).

Exit: every corpus entry is a named test; a `sql.read` token cannot reach `sql_execute`; a
confirmed target refuses a client without elicitation; live queries run against the
maintainer's SQL Server and PostgreSQL databases with dedicated read-only logins.

### M12 `ssh` (ACT-27, 28, 87, 88)

1. `feat(actions)`: `ssh2` connector with pinned host key, key and password auth, exec channel
   without PTY or forwarding, command allowlist, `any_command` behind the deployment switch;
   `ssh_run`; `actions:ssh`.

Exit: host-key mismatch fails before authentication in the contract suite; a live `uptime` runs
on a Linux host of the maintainer's under a one-pattern allowlist.

### M13 `winrm` (ACT-89, 90)

1. `spike(actions)`: evaluate the npm WinRM clients per QG-9 against a hand-written WS-Management
   client on `node:https`; record the decision in this plan.
2. `feat(actions)`: the chosen client, `cmd` and `powershell` shells, certificate pinning, shell
   lifecycle with `Signal` on timeout; `winrm_run`; `actions:winrm`.

Exit: the contract suite drives the five SOAP operations against a fake; a live
`Get-ComputerInfo` runs on a Windows host of the maintainer's over HTTPS with a pinned
certificate.

#### Spike result: the WS-Management client is hand-written (decided 2026-09-24)

`npm search winrm` returns five candidates with any plausible claim to the job. Each was
resolved with `npm install --package-lock-only` for its true transitive count and its published
source read for what it does on the wire. "Pinned address + separate SNI host" is ACT-55: the
socket must go to the one address the engine resolved and validated, while the URL's host name
stays the TLS server name. "Leaf certificate" is ACT-57's `certificate_sha256` pin: the client
must let vaultgate see the DER the server presented, before the credential is written.

| Package                     | Version, last publish | Deps (transitive)                                      | Native | TLS options                                             | Pinned address + separate SNI | Leaf certificate | Other baggage                                             |
| --------------------------- | --------------------- | ------------------------------------------------------ | ------ | ------------------------------------------------------- | ----------------------------- | ---------------- | --------------------------------------------------------- |
| `nodejs-winrm`              | 1.1.3, Sep 2020       | `uuid@3`, `js2xmlparser@3`, `xml2js@0.4` (7 packages)  | no     | none: `src/http.js` requires `node:http` only           | no                            | no               | `xml2js@0.4` predates the 0.5 prototype-pollution fix     |
| `@netcuras/nodejs-winrm`    | 1.4.0, Aug 2026       | `js2xmlparser@3`, `uuid@11`, `xml2js@0.6` (7 packages) | no     | whatever is passed through as `requestOptions`/`agent`  | not offered; would be a leak  | no               | no types shipped and none on DefinitelyTyped              |
| `winrm-client`              | 0.0.12, Mar 2026      | `fast-xml-parser`, `js-md4`, `uuid` (5 packages)       | no     | `rejectUnauthorized` — the option ACT-57 forbids having | no                            | no               | NTLM/SPNEGO with a hand-rolled MD4; `console` logger; 0.x |
| `node-winrm`                | 0.1.3, Dec 2016       | `edge` → `edge-cs` → `nan` (4 packages)                | yes    | n/a                                                     | no                            | no               | compiles a native addon and needs a .NET/Mono runtime     |
| `@devolutions/ironposh-web` | 0.6.0, Jul 2026       | none (1 package, 4.9 MB)                               | WASM   | none of its own (browser `fetch`)                       | no                            | no               | PSRP for WebAssembly, not a WS-Management shell client    |

Against those, the hand-written client: five SOAP operations (`Create`, `Command`, `Receive`,
`Signal`, `Delete`) built as five template literals over escaped text, driven through the pinned
transport that `http` already uses, and read by a parser written for exactly the elements the
five responses carry. No new dependency, no XML feature vaultgate does not need, and the two
things every package lacks — the pinned socket with a separate SNI host, and the leaf
certificate — come free, because the transport is the repository's own.

**Decision: hand-written**, as ACT-89 expected, and the evidence is stronger than the guess. The
disqualifications are not matters of taste: `nodejs-winrm` cannot speak HTTPS at all (its `https`
line is commented out), `node-winrm` fails QG-9's no-native-addons rule at the first hurdle,
`@devolutions/ironposh-web` is a different protocol for a different runtime, and `winrm-client`
would put an `rejectUnauthorized: false` switch and a hand-rolled MD4 into the tree for a
protocol subset vaultgate uses none of. `@netcuras/nodejs-winrm` is the only real contender —
maintained, small, HTTPS-capable — and it still cannot pin a socket, cannot show the certificate
it was given, and ships no types, so every call site would need the `any` the lint bans. Adopting
it would mean wrapping it in as much code as writing the five envelopes, and then owning the
wrapper as well as the dependency.

### M14 Policy UI polish and elicitation hardening (ACT-5…7, 41…49, 63)

1. `feat(actions)`: per-target call history and the "unexpected write" view, grant management
   from the connected-clients list, form validation messages for every policy field, a
   `confirm_writes` default-on for new writable targets.
2. `feat(actions)`: a confirmation message rendering test per connector, the compatibility-suite
   evidence of which clients render form-mode elicitation (12.2), and — in place of the
   older-protocol in-band elicitation fallback this milestone originally planned — the proof that
   the fallback is unimplementable under MCP-1 and the rewrite of ACT-48 that records why. The
   2025 wire declares elicitation once, at `initialize`, which a stateless per-request handler
   never sees; the SDK's own legacy shim refuses with "per-request legacy serving cannot receive
   server-to-client requests". The `confirmation_unavailable` refusal stays, and a test drives a
   real SDK client on the older version to pin what it actually gets.

Exit: every ACT id in sections 13 and 14 up to ACT-90 is cited by a test or allowlisted with its
reason in `scripts/check-requirement-citations.mjs`, which `npm run quality` enforces; the guides
(`tools-and-scopes.md`, `actions.md`) describe the layer.

### M15 `browser` (ACT-29…33, 91…102)

1. `build(docker)`: the optional `browser` Compose profile with the pinned Playwright image,
   internal network, seccomp, capability, filesystem and resource limits; the Azure template's
   `deployBrowserSidecar` parameter and second container.
2. `feat(actions)`: `playwright-core` over CDP, per-session contexts, the sign-in sequence with
   URI match and TOTP, origin interception, download and pop-up policy, snapshot and screenshot
   masking, the session registry with every close path; the six `browser_*` tools;
   `actions:browser`.

Exit: the fixture-site contract suite passes (ACT-102) including the marker-cookie invariant;
sessions close on token, consent and grant revocation and on target edit in the in-process
suite; a live sign-in to two of the maintainer's own web applications through the Compose
sidecar produces a scrubbed snapshot and a masked screenshot, recorded in the pull request.

### Post-1.0 candidates

- Passkey (WebAuthn) operator login.
- Upstream OIDC operator login.
- PostgreSQL store for multi-replica deployments.
- Prometheus metrics.
- Organisation collections filtering and per-client item allowlists.
- Actions follow-ups: `http_get` with `readOnlyHint: true`, Graph national clouds, further
  connectors only with a policy model as tight as spec 14.
- **Kerberos for `winrm`**, the successor to the NTLM that landed in M13. Microsoft deprecated
  every version of NTLM in June 2024 and is removing it in phases: auditing today, IAKerb and a
  Local KDC in the second half of 2026, and network NTLM blocked by default — policy can still
  re-enable it — in the next major Windows Server release
  ([Deprecated features in the Windows client](https://learn.microsoft.com/en-us/windows/whats-new/deprecated-features),
  [Advancing Windows security: disabling NTLM by default](https://techcommunity.microsoft.com/blog/windows-itpro-blog/advancing-windows-security-disabling-ntlm-by-default/4489526),
  recorded 2026-09-24). IAKerb and the Local KDC are what make Kerberos viable for the hosts this
  connector reaches with NTLM today — the workgroup machine with a local account, and the client
  with no line of sight to a domain controller — so they are the trigger for this work rather
  than a date. Nothing is promised, and nothing in ACT-89 stops working meanwhile: NTLM remains
  available by policy, and the blocking phase is a future server release.

## Test environments

Provided by the maintainer (details are kept out of this repository):

| Environment                                                                                                                                                 | Used by                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A dedicated test account on a self-hosted Vaultwarden instance, with a personal API key                                                                     | M5 integration job, M8 compatibility suite |
| An Azure subscription for template deployments                                                                                                              | M7 `what-if` and real deployments          |
| A Proxmox host for VM and container deployments                                                                                                             | M6 Compose and `install.sh` verification   |
| A public hostname for the reference deployment                                                                                                              | M6 onwards (to be assigned)                |
| The maintainer's own systems: an HTTPS API, a Microsoft 365 tenant, SQL Server and PostgreSQL databases, a Linux host, a Windows host, two web applications | M9 to M15 live tests (ACT-75), never in CI |

Open decision: the default `VAULTGATE_ACCESS_TOKEN_TTL` for hosted agents (1 h proposed), due by
M3.

## Risks

| Risk                                                      | Mitigation                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| SDK v2 is new (2.0.0); API churn                          | Pin exactly; isolate SDK usage behind `src/mcp/server.ts`; Dependabot PRs run the contract tests.                        |
| `bw serve` behaviour changes between CLI versions         | Minimum version gate; scheduled integration job against the latest CLI; the HTTP double encodes the contract we rely on. |
| SQLite on Azure Files                                     | Single replica, rollback journal, exclusive locking; documented; PostgreSQL store post-1.0.                              |
| Hosted clients change registration behaviour (DCR → CIMD) | Both supported; compatibility suite per release.                                                                         |
| Scope creep toward organisation administration            | Non-goals are written down; requests go to post-1.0 candidates.                                                          |
| The actions layer widens the attack surface (ADR 0007)    | Off by default per connector; typed connectors only; contract tests with canaries per connector; threat model T24…T34.   |
| Browser sidecar image carries Chromium's CVE stream       | Sidecar is optional and separate from the core image; pinned tag with Dependabot updates; dropped capabilities, seccomp. |
