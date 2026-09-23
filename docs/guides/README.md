# Guides

Task-oriented documentation for people running vaultgate. The normative detail behind every
guide is the specification in [`../spec/`](../spec/README.md); each guide links the sections it
relies on.

## Install

| Guide                                                             | What it covers                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Install with Docker Compose](install-docker-compose.md)          | The reference single-VM install: the image behind Caddy with automatic TLS. |
| [Install on Debian or Ubuntu](install-linux.md)                   | `install.sh`: a system user, `/opt/vaultgate`, a hardened systemd unit.     |
| [Azure Container Apps](../../deploy/azure/README.md)              | The ARM template, the Deploy to Azure button and its operating notes.       |
| [Reverse proxy](reverse-proxy.md)                                 | What the proxy in front of vaultgate must forward, with Caddy and nginx.    |
| [First run](first-run.md)                                         | From a fresh install to a working operator account and a ready vault.       |
| [Self-hosted Bitwarden and Vaultwarden](self-hosted-bitwarden.md) | The server field, the personal API key, Vaultwarden notes.                  |

## Connect an agent

| Guide                                             | What it covers                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| [Connect Claude](connect-claude.md)               | A custom connector in Claude web, desktop and Cowork; consent; revoking. |
| [Connect Claude Code](connect-claude-code.md)     | `claude mcp add --transport http …` and the in-session login.            |
| [Connect Codex](connect-codex.md)                 | `codex mcp add … --url …`, `codex mcp login` and `config.toml`.          |
| [Connect MCP Inspector](connect-mcp-inspector.md) | The Inspector's OAuth flow, its loopback callback, CLI mode.             |
| [Tools and scopes](tools-and-scopes.md)           | Every tool, its scope, inputs, outputs, and the secret-handling rules.   |

## Operate

| Guide                                           | What it covers                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| [Backup and restore](backup-and-restore.md)     | What to back up (the database and `VAULTGATE_SECRET_KEY`), how, and restore.  |
| [Upgrading](upgrading.md)                       | In-place upgrades per install method, migrations, rolling back.               |
| [Security model](security-model.md)             | The threat model in plain language; token lifetimes; what to do on a leak.    |
| [FAQ](faq.md)                                   | Short answers to the questions that come up first.                            |
| [Publishing to the MCP Registry](publishing.md) | `server.json`, `mcp-publisher`, the GitHub namespace, versioning per release. |
