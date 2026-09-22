# Connect Claude Code

Claude Code adds remote MCP servers from the command line and completes OAuth in your browser.
The syntax below is taken from the Claude Code documentation
([Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)); if a flag has
moved, that page wins.

## Add the server

```bash
claude mcp add --transport http vaultgate https://<host>/mcp
```

`<host>` is the host in `VAULTGATE_PUBLIC_URL`. The default scope is `local` (this project only).
To make it available in every project:

```bash
claude mcp add --transport http --scope user vaultgate https://<host>/mcp
```

`--scope project` writes a shared `.mcp.json` in the repository instead; think before committing
a vault connector into a shared project.

## Sign in

Inside a Claude Code session, run:

```text
/mcp
```

Select `vaultgate` and follow the browser flow: vaultgate's login page (display name, password,
authenticator or recovery code), then the consent page. Or, from the shell:

```bash
claude mcp login vaultgate
```

Claude Code registers with vaultgate dynamically and redirects to a loopback callback on your
machine, so the consent page shows the loopback warning ("this client redirects only to a
loopback address"). That is expected for a command-line client: confirm that you started the
connection yourself and continue. The rest of the consent page, the scope choices and revocation
are as described in [Connect Claude](connect-claude.md).

Tokens are stored by Claude Code and refreshed automatically. When the refresh token is rejected
(after 30 days without use, or after you disconnect the client on the account page) `/mcp`
shows the server as needing authentication; run `/mcp` again. In non-interactive runs
(`claude -p`), tools of a server that needs authentication are reported as unavailable until you
authorize it from an interactive session.

## Check, remove, sign out

```bash
claude mcp list
claude mcp get vaultgate
claude mcp remove vaultgate
claude mcp logout vaultgate
```

`logout` discards the stored tokens locally; it does not revoke them. Disconnect the client on
`https://<host>/account` when you mean to cut access.

## Pre-registering the client

vaultgate accepts dynamic registration, so nothing is required. If you prefer to pin the client,
Claude Code can use a fixed callback port and a client id you configure:

```bash
claude mcp add --transport http --callback-port 8080 --client-id claude-code \
  vaultgate https://<host>/mcp
```

Then pre-register the same id and redirect URI in vaultgate:

```bash
VAULTGATE_OAUTH_CLIENTS='[{"client_id":"claude-code","client_name":"Claude Code","redirect_uris":["http://localhost:8080/callback"]}]'
```

Check the exact callback path Claude Code uses in its documentation; redirect URIs are matched
exactly (only the port of a loopback address may vary). Do not pass `--client-secret`: vaultgate
supports public clients only.

## Using the tools

Once connected, the tools the token allows appear alongside Claude Code's own. Ask for a
password by name and Claude Code will search (`search_items`), then reveal exactly one field
(`get_secret`), each call audited. See [Tools and scopes](tools-and-scopes.md).

## Troubleshooting

- **`401` immediately after login**: `VAULTGATE_PUBLIC_URL` differs from the URL you added, or
  the proxy drops `Authorization`. See [Connect Claude § Troubleshooting](connect-claude.md#troubleshooting).
- **The browser opens but the callback never completes**: the callback port is in use or
  blocked locally. Set `--callback-port` to a free port and re-add the server.
- **`insufficient_scope`**: the token lacks a scope the tool needs. Disconnect on the account
  page and sign in again, ticking the scope.
