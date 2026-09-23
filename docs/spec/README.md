# vaultgate specification

This directory is the normative specification for vaultgate. Each section is a
separate file so that a change to one concern is a small, reviewable diff. The
plan that sequences the work is [`../PLAN.md`](../PLAN.md); the reasoning
behind the larger decisions is in [`../adr/`](../adr/README.md); the attacker
model is [`../THREAT_MODEL.md`](../THREAT_MODEL.md).

| Section                                               | Covers                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [01 Overview](01-overview.md)                         | Purpose, personas, principles, non-goals, glossary                                    |
| [02 Architecture](02-architecture.md)                 | Components, request flows, module layout, boundaries                                  |
| [03 OAuth 2.1](03-oauth.md)                           | Metadata, client registration, authorize, token, refresh, revoke                      |
| [04 Identity](04-identity.md)                         | First-run bootstrap, operator login, TOTP, sessions, CSRF                             |
| [05 Vault backend](05-vault-backend.md)               | Managed `bw serve`, credentials, sync, failure handling                               |
| [06 MCP surface](06-mcp-surface.md)                   | Transport, tools, scopes, secret-handling rules, audit                                |
| [07 Storage](07-storage.md)                           | SQLite schema, migrations, retention, backup                                          |
| [08 Configuration](08-configuration.md)               | Every environment variable, defaults, validation                                      |
| [09 Deployment](09-deployment.md)                     | Container image, Compose, install script, Azure Container App                         |
| [10 Operations](10-operations.md)                     | Logging, health, audit export, rate limits, upgrade, incident actions                 |
| [11 Quality gates](11-quality-gates.md)               | Lint, size limits, coverage, CI, supply chain, release                                |
| [12 Compatibility](12-compatibility.md)               | Protocol versions, clients, backwards compatibility                                   |
| [13 Actions](13-actions.md)                           | Targets, `actions:*` scopes, the tools, policy, elicitation, secret handling          |
| [13a Actions in operation](13a-actions-operations.md) | Destinations, limits, audit, storage, configuration, module layout, error codes       |
| [14 Action connectors](14-actions-connectors.md)      | `http` and Graph, `sql`; `ssh`, `winrm` and `browser` contracts and sidecar (planned) |

Requirement language follows RFC 2119: **MUST**, **SHOULD**, **MAY**.
Each requirement has an identifier (for example `OAUTH-12`) so tests and pull
requests can cite it.
