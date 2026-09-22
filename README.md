# vaultgate

[![CI](https://github.com/adamrowles1996/vaultgate/actions/workflows/ci.yml/badge.svg)](https://github.com/adamrowles1996/vaultgate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/adamrowles1996/vaultgate/actions/workflows/codeql.yml/badge.svg)](https://github.com/adamrowles1996/vaultgate/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/adamrowles1996/vaultgate/badge)](https://scorecard.dev/viewer/?uri=github.com/adamrowles1996/vaultgate)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A self-hosted, remote [MCP](https://modelcontextprotocol.io) server for
[Bitwarden](https://bitwarden.com) (and Vaultwarden) with a built-in OAuth 2.1
authorization server, so hosted AI agents such as Claude, Claude Cowork,
Claude Code and Codex can use your vault over HTTPS without ever holding your
master password.

> **Status: pre-release.** The implementation milestones for configuration and
> storage (M1), identity (M2), the MCP resource server (M4), the managed
> `bw serve` backend (M5), packaging (M6) and Azure (M7) are merged on `main`;
> the OAuth 2.1 authorization server (M3) is being completed on a branch, and
> M8 (hardening, compatibility evidence, user documentation) is in progress.
> Until M3 merges, `/mcp` challenges every request and no token can be issued.
> Follow [`docs/PLAN.md`](docs/PLAN.md) for progress.

## Why

Hosted agents connect to remote MCP servers over HTTPS with OAuth; they cannot
run a local process next to your vault. Bitwarden's official MCP server is
stdio-only and, correctly, says it must never be hosted publicly. vaultgate is
the authorization layer that makes remote access safe:

- **Agents hold tokens, not credentials.** Short-lived, scoped, audience-bound,
  revocable OAuth 2.1 access tokens. The master password lives only in the
  vaultgate process.
- **One door for secrets.** A single tool returns secret values, behind its own
  scope, with every call audited. Every other tool returns metadata.
- **No remote code execution.** There is no "run this command" tool. Ever.
- **Standards as written.** OAuth 2.1, PKCE, RFC 9728 / 8414 / 8707 / 7591 /
  7009 / 9207 and Client ID Metadata Documents, per the MCP authorization
  specification (2026-07-28).
- **Boring to operate.** One process, one SQLite file, structured logs, health
  probes, an audit trail. `docker compose up` is a complete installation.

## How it works

```text
Claude / Codex ──HTTPS + Bearer──▶ vaultgate ──loopback──▶ bw serve ──▶ Bitwarden
                 ▲                    │
                 └── OAuth 2.1 ◀──────┘  (consent page, operator login with TOTP)
```

1. An agent calls `/mcp` and is challenged with `WWW-Authenticate`.
2. It discovers the authorization server from the protected resource metadata,
   registers (Client ID Metadata Document, dynamic registration, or a
   pre-registered id) and sends you to the consent page.
3. You log in (password + TOTP) and approve the scopes:
   `vault:read`, `vault:reveal`, `vault:generate`, and optionally `vault:write`.
4. The agent receives tokens and can search items, read metadata, reveal one
   secret field at a time, generate passwords and, if allowed, create or update
   items.

## Install

TLS is always terminated in front of vaultgate; every method below ends with a
public `https://` origin that hosted agents can reach.

| Method                                  | Guide                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Docker Compose with Caddy (recommended) | [`docs/guides/install-docker-compose.md`](docs/guides/install-docker-compose.md) |
| Debian or Ubuntu VM, `install.sh`       | [`docs/guides/install-linux.md`](docs/guides/install-linux.md)                   |
| Your own reverse proxy (Caddy, nginx)   | [`docs/guides/reverse-proxy.md`](docs/guides/reverse-proxy.md)                   |

Releases publish `ghcr.io/adamrowles1996/vaultgate:<version>` for `linux/amd64` and
`linux/arm64`, signed with Sigstore cosign and carrying an SBOM and a provenance attestation,
plus `vaultgate-<version>.tgz` and its `.sha256` for the script install.

## Documentation

| Document                                       | What it is                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/guides/`](docs/guides/README.md)        | User guides: first run, connecting Claude, Claude Code, Codex and the Inspector, tools and scopes, self-hosted Bitwarden, backup, upgrading, security model, FAQ |
| [`docs/spec/`](docs/spec/README.md)            | The normative specification, one file per concern                                                                                                                |
| [`docs/PLAN.md`](docs/PLAN.md)                 | Milestones, exit criteria, risks                                                                                                                                 |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Assets, attackers, mitigations, residual risks                                                                                                                   |
| [`docs/adr/`](docs/adr/README.md)              | Architecture decision records                                                                                                                                    |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)           | Development workflow and quality gates                                                                                                                           |
| [`SECURITY.md`](SECURITY.md)                   | Reporting vulnerabilities                                                                                                                                        |

## Development

Requires Node 26 (see `.nvmrc`) and [mise](https://mise.jdx.dev) for the pinned external
linters.

```bash
mise install         # actionlint, shellcheck, shfmt, hadolint, gitleaks, editorconfig-checker
npm ci
npm run dev          # runs src/main.ts directly with Node's type stripping
npm run quality      # format, every linter, types, dead code, file sizes, provenance, tests at 100%
```

Every check that runs in CI runs locally with `npm run quality`. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules the repository enforces and why.

## Licence

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
