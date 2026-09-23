# FAQ

## Why not the official Bitwarden MCP server?

Because it is a local, stdio server, and its README says it must never be hosted publicly. That
is right for its design: it has no authorization layer, so whoever can reach it has the vault.
Hosted agents (Claude web, Cowork, Codex cloud) cannot start a process on your machine; they
connect to remote MCP servers over HTTPS with OAuth. vaultgate is that remote server, with an
OAuth 2.1 authorization server built in so that agents hold short-lived, scoped, revocable tokens
instead of your credentials ([ADR 0002](../adr/0002-own-authorization-server.md)).

## Why is there no "run this command with the secret" tool?

Local secret managers often offer one, so the model never sees the value. Over HTTPS, to a remote
server, that is remote code execution behind a bearer token. vaultgate exposes vault operations
only: no command execution, no file access, no arbitrary fetch. An agent that needs a secret in
a command reveals it (with `vault:reveal`, audited) and runs the command where it runs
([ADR 0004](../adr/0004-no-remote-command-execution.md)).

## Can several people share one instance?

No. Version 1 has exactly one operator account and one Bitwarden account per deployment. Every
connected agent acts for that one operator against that one vault. For several people, run one
deployment each. Multi-user and multi-vault are not planned for v1.

## The login page stopped asking for a name. Where do I type it?

Operators are identified by e-mail address since 0.1.0-rc.4; the display name is gone. An account
created by an earlier release has no address yet, so its login page asks for the password alone,
and after the authenticator step the account page asks you to confirm your password and set an
address before it shows anything else. From then on, sign in with that address. It is a login
identifier only: vaultgate never sends mail to it. You can change it from the account page after
confirming your password.

## Does it work with organisations and collections?

Reading, yes. `list_collections` shows the collections the account can see and `search_items`
filters by `collection_id`; organisation items are summarised and revealed like any other. What
vaultgate does not do is organisation administration: members, groups, policies and billing are
out of scope. Whether writes land in an organisation collection depends on what the Bitwarden CLI
allows the account to do; the write tools take a `folder_id`, not a collection.

## Can Claude create or change items?

Only with `vault:write`, which is off by default. Set `VAULTGATE_ENABLE_WRITE_SCOPE=true`,
restart, and tick the scope on the consent page when connecting. Even then there is no permanent
delete, only the trash, and a password can be set without the agent ever seeing it
(`generate_password: true`). See [Tools and scopes](tools-and-scopes.md).

## What data leaves my network?

Between vaultgate and Bitwarden: the same encrypted traffic the official clients send. Between
vaultgate and an agent: tool results, which are metadata except for `get_secret`, which returns
exactly one secret field per audited call. To anyone else: nothing. There is no telemetry, no
update check, and the only outbound request vaultgate makes on an agent's behalf is fetching a
client's metadata document when a client identifies itself with a URL.

## Does vaultgate see my master password?

Yes. The process reads it at start-up, hands it to `bw serve` over loopback to unlock the vault,
keeps it in memory for the life of the process and zero-fills it on shutdown. It is never written
to the database or the log. Agents never receive it and cannot obtain it from a token. Anyone
with root on the host could read process memory, which is why the host should run nothing else.

## Can I run it on Alpine?

Not the process as shipped. The Bitwarden CLI is a packaged Node binary linked against glibc,
which is why the container image is Debian based and the installer supports Debian and Ubuntu
only. On other systems, use the container image.

## Why do I need both an API key and my master password?

The API key logs the account in without the interactive prompts a headless process cannot
answer; the master password unlocks the data, because Bitwarden's servers never hold the key that
decrypts your vault. Neither alone is enough. See
[Self-hosted Bitwarden](self-hosted-bitwarden.md#why-the-api-key-and-the-master-password-are-both-needed).

## Does it work with Vaultwarden or bitwarden.eu?

Yes, both, through `VAULTGATE_BW_SERVER`. Vaultwarden needs a personal API key like Bitwarden
does, and the account must exist before vaultgate starts. See
[Self-hosted Bitwarden](self-hosted-bitwarden.md).

## Why must the server be on the public internet?

Claude's connections come from Anthropic's infrastructure, and Codex cloud's from OpenAI's, not
from your browser. A server reachable only on your LAN or VPN will never be reached. Claude Code,
the Codex CLI and the Inspector run on your machine and could reach a private server, but the
OAuth redirect and the `https` requirement still apply. Restricting inbound traffic to the
providers' published IP ranges is possible but is your firewall's job, not vaultgate's.

## What if I lose my authenticator?

Sign in with one of the eight recovery codes you were shown at setup, confirm your password on
the account page, and set up a new authenticator; then generate new recovery codes. If you have
no recovery codes either, there is no reset: the password alone does not sign you in. Stop the
service, move the database aside and start again to get a fresh bootstrap URL; every agent will
need to be connected again ([Backup and restore](backup-and-restore.md#if-the-database-is-lost)).

## How long does an agent stay connected?

Until you disconnect it on the account page, or until it goes 30 days without use. Access tokens
last an hour and are refreshed silently; refresh tokens are rotated on every use and expire 30
days after issue. Both lifetimes are configurable within bounds. See
[Security model](security-model.md#lifetimes).

## Can I connect a client that only supports pre-registered client ids?

Yes. `VAULTGATE_OAUTH_CLIENTS` takes a JSON array of public clients with their exact redirect
URIs; vaultgate validates it at start-up. There are no client secrets: vaultgate supports public
clients with PKCE only. Dynamic registration and Client ID Metadata Documents are supported too,
so most clients need nothing pre-registered.

## Where is the audit log?

In the database, for `VAULTGATE_AUDIT_RETENTION_DAYS`: every tool call, login, consent, token
and revocation is one row with the client, token id, tool, outcome, item id and field, but never
arguments or results. Export it from the account page (**Audit log**, after confirming your
password) as JSON Lines or CSV for a date range, or from the host with
`node dist/cli.js audit export --from 2026-01-01 --to 2026-02-01 [--format csv]` under the same
configuration as the server (`npm run audit:export -- …` from a source checkout). The window is
UTC, `from` inclusive and `to` exclusive; ship the file to whatever you keep logs in.
