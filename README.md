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

> **Status: release candidate.** Milestones M1 to M7 are merged: configuration, SQLite store,
> operator identity with TOTP, the OAuth 2.1 authorization server, the MCP tool surface, the
> managed `bw serve` backend, the audit trail, packaging and the Azure template. M8 (hardening and
> compatibility evidence) is in progress, and M9 (the off-by-default actions layer with its
> `http` connector) has landed; see [`docs/PLAN.md`](docs/PLAN.md).

## Why

**The agent never holds your credentials.** A hosted agent (Claude, Claude Cowork, Claude Code,
Codex) holds a short-lived, scoped, revocable OAuth 2.1 access token; the master password and API
key live only in the vaultgate process on your host. Hosted agents reach MCP servers over HTTPS
and cannot run a process next to your vault, and the other Bitwarden MCP servers are built for
exactly that local process:

| Server                                                                                                                                                                         | Where it runs                                                  | Who holds the master password / API key                                                                        | Client authorization                                                                                                                               | Consent and scopes                                                                                      | Revocation                                                                                           | Audit trail                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Official `bitwarden/mcp-server`](https://github.com/bitwarden/mcp-server)                                                                                                     | Local, stdio; its README says it must never be hosted publicly | Your machine: the `bw` CLI session (`BW_SESSION`) in the client's configuration, or an OS password dialog      | None; whoever launches the process                                                                                                                 | None; every tool is available to the launching client                                                   | Lock the vault or end the `bw` session                                                               | Not described                                                                    |
| [warden-mcp](https://github.com/icoretech/warden-mcp), remote mode                                                                                                             | A long-running HTTP service you host                           | The client, which sends them as `X-BW-Password`, `X-BW-ClientId` and `X-BW-ClientSecret` headers on every call | None built in ("no built-in authentication layer in v1")                                                                                           | None; `READONLY` and `NOREVEAL` switches apply to every client alike                                    | Rotate the Bitwarden credentials                                                                     | Not described                                                                    |
| Typical community servers, e.g. [vaultwarden-mcp](https://github.com/rmangaha/vaultwarden-mcp), [bitwarden-mcp-server](https://github.com/giuliolibrando/bitwarden-mcp-server) | Local stdio, or a plain HTTP port                              | The server process, from environment variables holding the e-mail address and master password                  | None                                                                                                                                               | None                                                                                                    | Rotate the Bitwarden credentials                                                                     | Not described                                                                    |
| vaultgate                                                                                                                                                                      | Your host, reachable over HTTPS by hosted agents               | The vaultgate process only; the agent holds an opaque token                                                    | Built-in OAuth 2.1 authorization server: operator login with TOTP, PKCE, RFC 9728 / 8414 / 8707 / 7591 / 7009 / 9207, Client ID Metadata Documents | Per-client consent page; `vault:read`, `vault:reveal`, `vault:generate`, `vault:write` (off by default) | Per client or per token from the account page; refresh tokens rotate and a replay revokes the family | Every tool call, login, consent, token issue, refresh and revocation, exportable |

"Not described" means the project's README does not document one. Dated verification notes with
links, and when the official stdio server is the better choice: [`docs/comparison.md`](docs/comparison.md).

What the design gives you beyond the table:

- **The master password stays with vaultgate.** It lives only in the process, and encrypted under
  your secret key once you connect the vault from the account page; agents hold short-lived,
  scoped, revocable tokens.
- **One door for secrets.** A single tool returns secret values, one field of one item per call,
  behind its own scope, with every call audited. Every other tool returns metadata.
- **No remote code execution.** There is no "run this command" tool. An off-by-default
  actions layer ([ADR 0007](docs/adr/0007-typed-actions-with-operator-policy.md),
  [spec 13](docs/spec/13-actions.md), [guide](docs/guides/actions.md)) lets an agent use a
  credential against an `http` target you define, under your allowlist, without ever seeing it
  (further connectors follow); nothing runs on the vaultgate host.
- **Standards as written.** OAuth 2.1, PKCE, RFC 9728 / 8414 / 8707 / 7591 /
  7009 / 9207 and Client ID Metadata Documents, per the MCP authorization
  specification (2026-07-28).
- **Any Bitwarden.** bitwarden.com, bitwarden.eu, self-hosted Bitwarden and Vaultwarden.
- **Boring to operate.** One process, one SQLite file, structured logs, health
  probes, an audit trail. `docker compose up` is a complete installation.

## Quick start

The current version is 0.1.0-rc.5 (`package.json`; releases are tagged on GitHub). On a VM with
Docker Engine, the Compose plugin, a DNS name pointing at it and ports 80 and 443 reachable from
the internet:

```bash
git clone https://github.com/adamrowles1996/vaultgate.git
cd vaultgate
cp .env.example .env
```

Set `VAULTGATE_DOMAIN`, `VAULTGATE_PUBLIC_URL` and `VAULTGATE_VERSION` in `.env`, then:

```bash
mkdir -p secrets
head -c 32 /dev/urandom | base64 > secrets/vaultgate_secret_key
touch secrets/bw_password secrets/bw_client_secret
chmod 0400 secrets/* && sudo chown 10001 secrets/*
docker compose up -d
docker compose logs -f vaultgate
```

First run: the log prints a one-time `/setup?token=…` URL. Open it and create the operator
account with an e-mail address, a password and a code from your authenticator (TOTP). That
password is vaultgate's own operator login; it is not, and never becomes, your Bitwarden master
password. Sign in, and on the account page connect the vault: server, API key client id and
secret, and master password. vaultgate stores that connection encrypted under
`VAULTGATE_SECRET_KEY`, so it survives restarts and upgrades. Then add `https://<host>/mcp` to
Claude (or Claude Code, Codex, the MCP Inspector) as a remote MCP server and approve the scopes on
the consent page. The `bw` CLI that vaultgate drives is bundled in the image and installed by
`install.sh`; nothing else is needed on the host. Walkthrough:
[`docs/guides/first-run.md`](docs/guides/first-run.md); details and the verification of the
image: [`docs/guides/install-docker-compose.md`](docs/guides/install-docker-compose.md).

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
| [`docs/comparison.md`](docs/comparison.md)     | How vaultgate differs from the other Bitwarden MCP servers, with dated verification notes                                                                        |
| [`docs/adoption.md`](docs/adoption.md)         | Listings, channels and app-store definitions, with the submission mechanics for each                                                                             |
| [`server.json`](server.json)                   | The MCP Registry listing; how to publish it: [`docs/guides/publishing.md`](docs/guides/publishing.md)                                                            |
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
