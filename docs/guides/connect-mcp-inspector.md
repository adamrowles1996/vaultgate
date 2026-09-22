# Connect the MCP Inspector

The [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) is the reference
client for testing an MCP server. It is the quickest way to watch vaultgate's handshake, list
the tools a token allows and call one by hand. Syntax and callback URLs below come from the
Inspector's documentation; check there if a flag has changed.

## Web client

```bash
npx @modelcontextprotocol/inspector --server-url https://<host>/mcp --transport http
```

The launcher prints a `http://localhost:6274/?MCP_INSPECTOR_API_TOKEN=…` URL; open that URL,
not a remembered address, because the token guards the Inspector's own backend. Connect to the
server. The Inspector receives `401`, reads the protected resource metadata, registers itself
with vaultgate dynamically and opens vaultgate's login and consent pages.

The web Inspector's OAuth callback is `http://localhost:6274/oauth/callback`, a loopback
address, so the consent page shows its loopback warning:

> Warning: this client redirects only to a loopback address (`localhost:6274`). Any program on
> the computer running your browser could be listening there; make sure you started this
> connection yourself.

That is the intended behaviour for a tool running on your own machine. Continue with **Allow**.
The Inspector's Connection Info panel then shows the registered client, the granted scopes and
the token state, and offers **Clear OAuth state**.

Under **Tools** you will see only the tools the granted scopes allow (`tools/list` is filtered per
token). Call `vault_status` first, then `search_items`; a `get_secret` call without
`vault:reveal` shows the `403 insufficient_scope` challenge in the **Network** tab.

## CLI client

The CLI and TUI share a separate callback, `http://127.0.0.1:6276/oauth/callback`. A first run
with a terminal attached opens the browser for consent; the resulting tokens are stored
owner-only under `~/.mcp-inspector/storage/oauth.json`, keyed by server URL, and shared by all
three Inspector clients.

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url https://<host>/mcp \
  --method tools/list

npx @modelcontextprotocol/inspector --cli --transport http --server-url https://<host>/mcp \
  --method tools/call --tool-name search_items --tool-arg query=github
```

For scripts and CI, `--stored-auth-only` never starts a browser flow and fails fast when no
stored token exists; `--use-stored-auth` reuses (and refreshes) a token obtained in the web
client. vaultgate rotates refresh tokens on every use, so do not run two `--use-stored-auth`
invocations concurrently against the same state file; the second replay revokes the family and
you must sign in again.

Pass a token you already hold instead of the stored one with
`--header 'Authorization: Bearer <token>'`. Never put a token in the URL: vaultgate rejects
`access_token` in the query string with `400`.

## Pre-registering the Inspector

Dynamic registration needs nothing on the vaultgate side. To pin the client instead, register the
Inspector's callback URLs and pass the id on the command line:

```bash
VAULTGATE_OAUTH_CLIENTS='[{"client_id":"mcp-inspector","client_name":"MCP Inspector","redirect_uris":["http://localhost:6274/oauth/callback","http://127.0.0.1:6276/oauth/callback"]}]'
```

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url https://<host>/mcp \
  --client-id mcp-inspector --method tools/list
```

`localhost` and `127.0.0.1` are different redirect URIs; register the one each client uses. Only
the port of a loopback redirect may differ from what was registered. The Inspector also accepts
`--client-metadata-url` for a Client ID Metadata Document, which vaultgate supports as well.

## Reading the handshake

The **Network** tab shows the exchange as it happens:

| Step                                            | What vaultgate sends                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| First `POST /mcp` without a token               | `401`, `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="vault:read"` |
| `GET /.well-known/oauth-protected-resource/mcp` | The resource, the authorization server (the public URL), the four scopes, `bearer_methods_supported: ["header"]`                  |
| A call outside the token's scopes               | `403`, `WWW-Authenticate: Bearer error="insufficient_scope", scope="<every scope the call needs>", …`                             |
| An expired or revoked token                     | `401`, `WWW-Authenticate: Bearer error="invalid_token", …`; the Inspector re-runs the flow and retries                            |
| More than 120 tool calls in a minute            | `429` with `Retry-After`                                                                                                          |

A `403` with `{"error":"forbidden"}` and no `WWW-Authenticate` header is the Origin or Host
check: the Inspector sent an `Origin` that is not the public URL, or the `Host` reaching vaultgate
is not the public host. Add the Inspector's origin to `VAULTGATE_ALLOWED_ORIGINS` only if you
understand why it is needed; normally the fix is the reverse proxy configuration.

## Cleaning up

Clear the Inspector's stored tokens with **Clear OAuth state** (web), the **Auth** tab (TUI) or
`--relogin` (CLI), and disconnect the client on `https://<host>/account` to revoke the tokens on
the server side.
