# vaultgate compared with other Bitwarden MCP servers

The one-sentence claim is **the agent uses your credentials without ever holding them**. This
page shows what that means against the other Bitwarden MCP servers, cites what each project's own
README says, and ends with the cases where vaultgate is not the right choice.

Every statement about another project was verified on **2026-09-23** from that project's README
(`gh api repos/<owner>/<repo>/readme`) and, where noted, its source. "Not described" means the
README does not document the feature; it is not a claim that the feature is absent. Re-check
before quoting: these projects move.

## The table

| Property                                | Official `bitwarden/mcp-server`                                                                             | warden-mcp, remote mode                                                                                                                                 | Typical community servers                                                                                                                                              | vaultgate                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                              | [bitwarden/mcp-server](https://github.com/bitwarden/mcp-server)                                             | [icoretech/warden-mcp](https://github.com/icoretech/warden-mcp)                                                                                         | [rmangaha/vaultwarden-mcp](https://github.com/rmangaha/vaultwarden-mcp), [giuliolibrando/bitwarden-mcp-server](https://github.com/giuliolibrando/bitwarden-mcp-server) | [adamrowles1996/vaultgate](https://github.com/adamrowles1996/vaultgate)                                                                                                                                                                                                           |
| Language, licence                       | TypeScript, GPL-3.0                                                                                         | TypeScript, MIT                                                                                                                                         | Python (both); no licence file (both)                                                                                                                                  | TypeScript, Apache-2.0                                                                                                                                                                                                                                                            |
| Transport                               | stdio only                                                                                                  | stdio, or Streamable HTTP at `/sse?v=2`                                                                                                                 | stdio (vaultwarden-mcp); Streamable HTTP on port 8007 (bitwarden-mcp-server)                                                                                           | Streamable HTTP at `/mcp`; no stdio                                                                                                                                                                                                                                               |
| Where it runs                           | Your machine, launched by the MCP client. README: "must never be hosted publicly or exposed over a network" | A long-running service you host; the README suggests a reverse proxy, VPN or tunnel for hosted clients                                                  | Your machine, or a container you run                                                                                                                                   | Your host, behind TLS, reachable over HTTPS by hosted agents                                                                                                                                                                                                                      |
| Who holds the master password / API key | Your machine: `BW_SESSION` from `bw unlock --raw` in the client's configuration, or the OS password dialog  | The client: `X-BW-Password`, `X-BW-ClientId`, `X-BW-ClientSecret` request headers on every call; or the server, with `KEYCHAIN_ALLOW_ENV_FALLBACK=true` | The server process, from environment variables (`VAULTWARDEN_MASTER_PASSWORD`; `BITWARDEN_EMAIL` and `BITWARDEN_PASSWORD`)                                             | The vaultgate process, in memory, for the life of the process; the agent holds an opaque `vg_at_…` token                                                                                                                                                                          |
| Client authorization                    | None; whoever launches the process                                                                          | None built in: "There is no built-in authentication layer in v1. Protect the transport before you expose it."                                           | None                                                                                                                                                                   | OAuth 2.1 authorization server: PKCE, RFC 9728, 8414, 8707, 7591, 7009, 9207, Client ID Metadata Documents; operator login with password and TOTP                                                                                                                                 |
| Consent and scopes                      | None; every tool is available to the launching client                                                       | None per client; `READONLY` and `NOREVEAL` are server-wide switches                                                                                     | None; vaultwarden-mcp is read-only when no master password is configured                                                                                               | Consent page per client; `vault:read`, `vault:reveal`, `vault:generate`, `vault:write` (off unless `VAULTGATE_ENABLE_WRITE_SCOPE=true`); `tools/list` filtered by scope                                                                                                           |
| Token model                             | Not applicable                                                                                              | Not applicable: the vault credentials are the bearer                                                                                                    | Not applicable                                                                                                                                                         | Opaque, hashed at rest, audience-bound to `/mcp`; access 1 h, refresh 30 days, single-use with rotation; replay revokes the family                                                                                                                                                |
| Revocation                              | Lock the vault or end the `bw` session                                                                      | Rotate the Bitwarden credentials                                                                                                                        | Rotate the Bitwarden credentials                                                                                                                                       | Disconnect a client (all its tokens) or revoke a token (RFC 7009); scope changes never widen on refresh                                                                                                                                                                           |
| Audit trail                             | Not described                                                                                               | Not described (`/metricsz` exposes counters)                                                                                                            | Not described                                                                                                                                                          | Every tool call, login, consent, token issue, refresh and revocation, with item id and field for reveals; exportable, 365-day default retention                                                                                                                                   |
| Secret handling                         | Tools return full items                                                                                     | Redacted unless a tool supports `reveal: true` and the client asks                                                                                      | Full item bodies                                                                                                                                                       | One secret field of one item per `get_secret` call; TOTP code only, never the seed; search returns no secret values                                                                                                                                                               |
| Using a credential without seeing it    | Not described                                                                                               | Not described                                                                                                                                           | Not described                                                                                                                                                          | Typed actions at operator-defined targets, off unless enabled: `http_request` (with a Microsoft Graph adapter), `sql_query`, `sql_execute`, `ssh_run`, `winrm_run`; every injected value is scrubbed from the result ([ADR 0007](adr/0007-typed-actions-with-operator-policy.md)) |
| Command execution tool                  | No                                                                                                          | No                                                                                                                                                      | No                                                                                                                                                                     | No arbitrary one ([ADR 0004](adr/0004-no-remote-command-execution.md)). `ssh_run` and `winrm_run` run one command on one operator-configured host under an allowlist; nothing executes on the vaultgate host                                                                      |
| Bitwarden servers                       | bitwarden.com; self-hosted via `BW_API_BASE_URL` / `BW_IDENTITY_URL`                                        | Vaultwarden and Bitwarden via `BW_HOST`                                                                                                                 | Vaultwarden or Bitwarden via a base URL                                                                                                                                | bitwarden.com, bitwarden.eu, self-hosted Bitwarden, Vaultwarden                                                                                                                                                                                                                   |
| Organisation administration             | Yes: collections, members, groups, policies, event logs, billing (Public API)                               | Collections and organisation items                                                                                                                      | No                                                                                                                                                                     | No: `list_collections` only                                                                                                                                                                                                                                                       |

## Verification notes

### Official `bitwarden/mcp-server`

Checked 2026-09-23. TypeScript, GPL-3.0, 260 stars, last push 2026-09-17.

- Transport: the client configuration is `command: npx -y @bitwarden/mcp-server`; "Any
  MCP-compatible client can connect to this server via stdio transport." No HTTP transport is
  documented.
- Hosting: the README's first warning is "This MCP server is designed exclusively for local use
  and must never be hosted publicly or exposed over a network", followed by "Never: Deploy this
  server to cloud hosting, containers, or public servers".
- Credentials: `BW_SESSION` from `bw login` and `bw unlock --raw` is placed in the client's
  configuration file (the README warns the file "will contain sensitive credentials"); the vault
  can also be unlocked "via native OS password dialog", with the password passed to `bw unlock`
  through a one-shot environment variable. Organisation administration adds `BW_CLIENT_ID` and
  `BW_CLIENT_SECRET`.
- Authorization, consent, audit: none described. The README lists what the assistant gains
  ("Read vault items including passwords", "Create, modify, and delete vault items") and puts the
  responsibility on the operator: "Monitoring logs for unexpected activity". The organisation
  "Audit Logs" tool reads Bitwarden's event history; it is not a trail of the server's own calls.

### icoretech/warden-mcp

Checked 2026-09-23. TypeScript, MIT, 17 stars, last push 2026-09-20. Listed under Security in
[awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers).

- Transport: stdio (`--stdio`) or a "Shared HTTP mode" whose MCP endpoint is `/sse?v=2`,
  documented as the "MCP Streamable HTTP endpoint".
- Credentials in HTTP mode: "MCP tool calls must include these headers unless env fallback is
  explicitly enabled": `X-BW-Host`, `X-BW-Password` ("master password used to unlock the vault"),
  `X-BW-ClientId`, `X-BW-ClientSecret`, or `X-BW-User`. The example client configuration places
  all four in the MCP host's `headers`. With `KEYCHAIN_ALLOW_ENV_FALLBACK=true` the server holds
  them instead, and "Every client that can reach the endpoint inherits the configured vault
  identity."
- Authorization: the Security Model section opens with "There is no built-in authentication layer
  in v1. Protect the transport before you expose it." and recommends binding to `127.0.0.1`, a
  firewall, VPN or "an authenticated reverse proxy", and TLS because "`X-BW-*` headers carry vault
  credentials".
- Consent and scopes: server-wide `READONLY` / `KEYCHAIN_READONLY` and `NOREVEAL` /
  `KEYCHAIN_NOREVEAL` switches; secret fields "stay redacted unless a tool supports `reveal: true`
  and the client explicitly asks for it".
- Audit: not described; `/metricsz` "exposes runtime/session counters" and is unauthenticated.

### Community servers taking credentials from the environment

Checked 2026-09-23. Two examples; several more exist with the same shape
(`gh api 'search/repositories?q=bitwarden+mcp+server'`).

- [rmangaha/vaultwarden-mcp](https://github.com/rmangaha/vaultwarden-mcp): Python, no licence
  file, last push 2026-05-26. stdio: the documented client configuration is `command:
vaultwarden-mcp` with `VAULTWARDEN_EMAIL`, `VAULTWARDEN_CLIENT_ID`, `VAULTWARDEN_CLIENT_SECRET`
  and `VAULTWARDEN_MASTER_PASSWORD` in `env`. "Read-only safe mode when no master password is
  configured."
- [giuliolibrando/bitwarden-mcp-server](https://github.com/giuliolibrando/bitwarden-mcp-server):
  Python, no licence file, last push 2025-11-17. Not stdio: `server.py` runs FastMCP with
  `transport="streamable-http"` on `SERVER_PORT` (default 8007), and the Docker Compose file
  publishes that port. Credentials come from `BITWARDEN_EMAIL` and `BITWARDEN_PASSWORD` in `.env`.
  No client authentication is implemented or described.

### vaultgate

Checked against this repository at the same date. Sources: [security model](guides/security-model.md),
[tools and scopes](guides/tools-and-scopes.md), [03 OAuth](spec/03-oauth.md),
[12 Compatibility](spec/12-compatibility.md), [13 Actions](spec/13-actions.md),
[ADR 0004](adr/0004-no-remote-command-execution.md), [ADR 0007](adr/0007-typed-actions-with-operator-policy.md).

- The agent "holds an access token and nothing else. It never sees the master password, the API
  key, or the CLI session."
- Tokens: OAUTH-24 (opaque `vg_at_` / `vg_rt_`, SHA-256 at rest), OAUTH-25 (rotation, family
  revocation on replay), OAUTH-29 (RFC 7009 revocation), OAUTH-36 (no scope implies another).
- Audit: "Every tool call, login, consent, token issue, refresh and revocation is an audit event",
  exported from the console's Activity page or `node dist/cli.js audit export`.
- Servers: COMPAT table 12.3: bitwarden.com, bitwarden.eu, self-hosted Bitwarden, Vaultwarden.
- Actions: spec 13.1, "The actions layer lets an agent _use_ a credential without ever receiving
  it"; the engine's resolution order is ACT-16, scrubbing is section 13.9, and the layer and each
  connector are off unless switched on (section 13.14).

## When not to use vaultgate

- **One machine, one local agent.** If the agent runs on the same computer as you (Claude Desktop,
  Claude Code or Codex CLI on your laptop) and nothing needs to reach your vault from outside it,
  the official stdio server is simpler: no TLS, no public origin, no operator account, no extra
  process to back up. vaultgate exists for the case the official README rules out, an agent that
  is not on your machine.
- **Organisation administration.** Members, groups, policies, billing and Bitwarden event logs are
  the official server's Public API tools. vaultgate reads collections and nothing else at
  organisation level.
- **Attachments, Sends, item deletion.** vaultgate does not expose them; `trash_item` is the most
  destructive tool. Use the official server or `bw` directly.
- **Secret injection into commands on your own machine.** vaultgate runs typed operations only at
  targets you define, and never on its own host or the agent's (ADR 0004, ADR 0007). If you want a
  secret substituted into an arbitrary command where the agent runs, a local server with the `bw`
  CLI is the right shape.
- **Many users.** vaultgate has one operator per deployment, backed by one Bitwarden account. It is
  not a multi-tenant gateway.
