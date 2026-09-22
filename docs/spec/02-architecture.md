# 02 Architecture

## 2.1 Components

```
                 HTTPS (reverse proxy or Container Apps ingress)
                                   │
   ┌───────────────────────────────┼─────────────────────────────────────┐
   │ vaultgate (one Node 24 process)                                     │
   │                               │                                     │
   │   ┌──────────────┐   ┌────────┴─────────┐   ┌───────────────────┐   │
   │   │ Consent UI   │   │ OAuth 2.1 AS     │   │ MCP resource      │   │
   │   │ /login       │   │ /.well-known/*   │   │ server            │   │
   │   │ /setup       │◄──┤ /oauth/authorize │   │ POST /mcp         │   │
   │   │ /account     │   │ /oauth/token     │   │ bearer validation │   │
   │   └──────┬───────┘   │ /oauth/register  │   │ scope enforcement │   │
   │          │           │ /oauth/revoke    │   │ tool dispatch     │   │
   │          │           └────────┬─────────┘   └─────────┬─────────┘   │
   │          │                    │                       │             │
   │   ┌──────┴────────────────────┴───────┐     ┌─────────┴─────────┐   │
   │   │ Store (SQLite via node:sqlite)    │     │ Vault client      │   │
   │   │ operators, sessions, clients,     │     │ (HTTP to loopback)│   │
   │   │ consents, codes, tokens, audit    │     └─────────┬─────────┘   │
   │   └───────────────────────────────────┘               │             │
   │                                              ┌────────┴──────────┐  │
   │                                              │ bw serve (child)  │  │
   │                                              │ 127.0.0.1:<port>  │  │
   │                                              └────────┬──────────┘  │
   └───────────────────────────────────────────────────────┼─────────────┘
                                                           │ HTTPS
                                            Bitwarden cloud / self-hosted / Vaultwarden
```

| Component            | Responsibility                                                                                       | Module                           |
| -------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| HTTP application     | Hono app: routing, security headers, request ids, error masking, rate limiting                       | `src/http/`                      |
| Authorization server | Metadata documents, client resolution (CIMD, DCR, pre-registered), authorize, token, refresh, revoke | `src/oauth/`                     |
| Identity             | Bootstrap, operator credentials (scrypt), TOTP, recovery codes, sessions, CSRF                       | `src/identity/`                  |
| MCP resource server  | Bearer verification, `WWW-Authenticate` challenges, scope gates, tool registry, Streamable HTTP      | `src/mcp/`                       |
| Vault backend        | `bw serve` lifecycle, unlock, sync, typed client for the Vault Management API, error mapping         | `src/bitwarden/`                 |
| Store                | SQLite connection, migrations, repositories, retention jobs                                          | `src/storage/`                   |
| Audit                | Append-only audit events, export                                                                     | `src/audit/`                     |
| Config and logging   | Environment validation, structured logs with redaction                                               | `src/config.ts`, `src/logger.ts` |

## 2.2 Module boundaries (enforced)

| Rule ID | Requirement                                                                                                                   | Enforcement                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| ARCH-1  | `process.env` is read only in `src/config.ts` (and passed in by `src/main.ts`). Every other module receives a `Config` value. | ESLint `no-restricted-syntax`                      |
| ARCH-2  | `child_process` is imported only by `src/bitwarden/serve-process.ts`.                                                         | ESLint `no-restricted-imports`                     |
| ARCH-3  | No module writes to `console`; all output goes through the pino logger with redaction.                                        | ESLint `no-console`                                |
| ARCH-4  | Vault secret values never enter the store, the logger, an error message or a non-`get_secret` tool result.                    | Code review, redaction tests, tool contract tests  |
| ARCH-5  | Every HTTP handler is testable in-process through `app.request()`; no handler depends on a live socket.                       | Test suite design                                  |
| ARCH-6  | The MCP tool layer depends on a `VaultClient` interface, never on `bw serve` directly, so tools are tested against a fake.    | TypeScript interface + fake in `src/test-support/` |
| ARCH-7  | No import cycles.                                                                                                             | ESLint `import-x/no-cycle`                         |

## 2.3 Request flows

### 2.3.1 First connection from a new agent

1. Agent `POST /mcp` without a token → `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="vault:read"`.
2. Agent fetches PRM, then AS metadata from `/.well-known/oauth-authorization-server`.
3. Agent registers: CIMD (uses its HTTPS URL as `client_id`), DCR (`POST /oauth/register`), or a
   pre-registered id from configuration.
4. Agent opens the browser at `/oauth/authorize?...&code_challenge=…&resource=…/mcp`.
5. vaultgate redirects to `/login` if no operator session; after login, renders consent showing the
   client name, its redirect host, and the requested scopes (with a warning for `localhost` redirects).
6. Operator approves → `302` to the client's `redirect_uri` with `code`, `state`, `iss`.
7. Agent `POST /oauth/token` with `code_verifier` and `resource` → access token (1 h) + refresh token (30 d).
8. Agent `POST /mcp` with `Authorization: Bearer vg_at_…` → tools list, tool calls.

### 2.3.2 A tool call

1. `requireBearerAuth` verifies the token hash, expiry, revocation and audience; loads scopes.
2. The MCP handler dispatches `tools/call`. The tool's declared scope is checked; on failure the
   response is `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="vault:reveal", …`.
3. The tool calls `VaultClient`, which calls `bw serve` on loopback.
4. The result is shaped by the tool contract (metadata only unless `get_secret`).
5. An audit event is appended: tool, client, subject, token id prefix, outcome, duration; never
   the secret value.

### 2.3.3 Start-up

1. Validate configuration; exit non-zero with a readable list of issues on failure.
2. Open SQLite, run pending migrations inside a transaction.
3. If no operator exists, generate a bootstrap token, log the `/setup?token=…` URL once.
4. Spawn `bw serve` on loopback with a random free port; log in with the API key if needed;
   unlock with the master password; run an initial sync. Readiness stays `503` until unlocked.
5. Start the HTTP listener. Register `SIGTERM`/`SIGINT` handlers that stop accepting requests,
   lock and stop `bw serve`, close the store, then exit.

## 2.4 Source layout

```
src/
  main.ts                 process entrypoint (excluded from unit coverage; covered by the CI smoke job)
  config.ts               environment schema → Config
  logger.ts               pino with redaction
  result.ts               Result<T, E>
  http/                   app factory, middleware, error mapping, rate limiting
  oauth/                  metadata, clients (cimd, dcr, preregistered), authorize, token, revoke, scopes
  identity/               bootstrap, password (scrypt), totp, recovery codes, sessions, csrf, pages
  mcp/                    bearer verifier, server factory, tool registry, tool contracts
  bitwarden/              serve-process (spawn boundary), vault-client, types, error mapping
  storage/                database, migrations/, repositories
  audit/                  event writer and export
  test-support/           fakes (in-memory VaultClient, fake bw serve HTTP double), fixtures
```

Every runtime file stays under 300 lines and every function under 60 (lint enforced).
