# Connect Codex

The Codex CLI adds remote MCP servers by URL and signs in with OAuth in your browser. The syntax
below is taken from the Codex documentation
([MCP servers in Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)); where the
documentation and this page differ, the documentation wins.

## Add the server

```bash
codex mcp add vaultgate --url https://<host>/mcp
```

`<host>` is the host in `VAULTGATE_PUBLIC_URL`. The command writes a table to Codex's
`config.toml`; the equivalent by hand is:

```toml
[mcp_servers.vaultgate]
url = "https://<host>/mcp"
```

Codex's default authentication mode for a remote server is OAuth, so no `auth` line is needed.
Do not set a bearer token: vaultgate issues tokens only through its OAuth flow.

## Sign in

```bash
codex mcp login vaultgate
```

Codex discovers vaultgate's authorization server from the `401` challenge, registers itself
(Codex supports dynamic client registration and Client ID Metadata Documents, and vaultgate
accepts both), and opens the browser on vaultgate's login page, then the consent page.

Codex redirects to a loopback callback on your machine, so the consent page shows the loopback
warning. That is expected for a command-line client; confirm that you started the connection and
continue. Codex's documentation describes `mcp_oauth_callback_port` in `config.toml` if you need a
fixed port; check there for the exact callback URL before pre-registering anything. Scope choice
and revocation are as in [Connect Claude](connect-claude.md).

## Pre-registered client

If you would rather pin the client than allow dynamic registration:

```bash
codex mcp add vaultgate --url https://<host>/mcp --oauth-client-id codex
```

and register the same id in vaultgate with the exact redirect URI Codex uses:

```bash
VAULTGATE_OAUTH_CLIENTS='[{"client_id":"codex","client_name":"Codex","redirect_uris":["http://localhost:<port>/<path>"]}]'
```

Redirect URIs are compared exactly, except that the port of a loopback address may vary. vaultgate
supports public clients only, so there is no client secret.

## List, remove

```bash
codex mcp list
codex mcp --help
```

Removing the server from `config.toml` discards Codex's copy of the tokens but does not revoke
them; disconnect the client on `https://<host>/account/agents` when you mean to cut access.

## Codex cloud

Codex's hosted environments connect from OpenAI's infrastructure rather than your machine, so
the same rule as for Claude applies: `https://<host>/mcp` must be reachable from the public
internet. Check the Codex documentation for how a cloud environment is given an MCP server.

## Troubleshooting

- **`401` after a successful login**: `VAULTGATE_PUBLIC_URL` is not the URL Codex uses, or the
  proxy drops the `Authorization` header. See
  [Connect Claude § Troubleshooting](connect-claude.md#troubleshooting).
- **The browser never returns to Codex**: the loopback callback port is in use. Set a fixed port
  with `mcp_oauth_callback_port` and sign in again.
- **`insufficient_scope`**: the token lacks a scope the tool needs. Disconnect on the account
  page and sign in again, ticking the scope.
