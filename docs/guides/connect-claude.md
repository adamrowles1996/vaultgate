# Connect Claude

Adding vaultgate to Claude (web, desktop and Cowork) as a custom connector. Claude speaks to
remote MCP servers over HTTPS with OAuth 2.1; vaultgate is its own authorization server, so there
is nothing to configure on the Claude side beyond the URL. The flow is specified in
[03 OAuth 2.1](../spec/03-oauth.md).

## Before you start

- vaultgate is installed, `/readyz` returns `200`, and you have completed [First run](first-run.md).
- The connector URL is `https://<host>/mcp`, where `<host>` is the host in `VAULTGATE_PUBLIC_URL`.
  No trailing slash.
- The server is reachable from the public internet. Claude's connections originate from
  Anthropic's infrastructure, not from your browser or laptop, so a server on a private network,
  behind a VPN, or blocked by a firewall will not connect. Anthropic's help centre publishes the
  IP ranges to allow if you must restrict inbound traffic
  ([Getting started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)).

## Add the connector

The location in Claude's settings depends on the plan, and Anthropic moves things occasionally;
the help-centre article above is authoritative. At the time of writing:

| Plan                      | Where                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| Pro, Max                  | Customize → Connectors → **+** → **Add custom connector**                 |
| Team, Enterprise (owner)  | Organization settings → Connectors → **Add** → **Custom** → **Web**       |
| Team, Enterprise (member) | Customize → Connectors, then **Connect** on the connector the owner added |

Enter a name (for example `vaultgate`) and the remote MCP server URL `https://<host>/mcp`.
Leave the optional OAuth client ID and secret under **Advanced settings** empty: Claude registers
itself with vaultgate dynamically, and vaultgate issues no client secrets (it supports public
clients only). Click **Add**, then **Connect**.

Custom connectors are available in Claude web, Claude Desktop, Cowork and the mobile apps; a
connector added once is used from all of them, because the connection is made by Anthropic's
servers on your behalf.

## What happens when you click Connect

1. Claude calls `https://<host>/mcp` and is answered `401` with a `WWW-Authenticate` header
   pointing at vaultgate's protected resource metadata.
2. Claude reads that document and the authorization server metadata at
   `/.well-known/oauth-authorization-server`, then registers as a client. Today Claude uses
   dynamic client registration (`POST /oauth/register`); vaultgate also accepts Client ID Metadata
   Documents and pre-registered client ids.
3. Your browser is sent to `https://<host>/oauth/authorize`. If you are not signed in, vaultgate
   shows its login page (display name, password, then authenticator or recovery code) and
   continues to the consent page afterwards.
4. You approve on the consent page. vaultgate redirects back to Claude with a one-time
   authorization code; Claude exchanges it, with PKCE, for an access token and a refresh token.
5. Claude lists the tools your token allows and starts using them.

## The consent page

The page is titled **Allow access to your vault?** and shows:

- **Client name**: what the client registered as, for example Claude's own name.
- **Will redirect to**: the host the authorization code will be sent to. For Claude this is an
  Anthropic-owned host. If it is anything you do not recognise, deny.
- **Registration**: how vaultgate knows the client: _pre-registered by the operator_, _identified
  by its client metadata document (URL client id)_, or _registered dynamically; nobody has vetted
  this client_. The last is normal for Claude today and is why the redirect host matters.
- A prominent warning when the client redirects only to a loopback address (`localhost`,
  `127.0.0.1`, `[::1]`). Claude never does; command-line tools do (see
  [Connect Claude Code](connect-claude-code.md)).
- **Permissions requested**: one checkbox per scope with a one-line explanation. `vault:reveal`
  and `vault:write` carry a **Sensitive** marker.

Untick any scope you do not want this client to have; the token carries only what you leave
ticked. `vault:read` cannot be unticked, because every client needs it to do anything. Click
**Allow** or **Deny**. Denying sends Claude an `access_denied` error and nothing is stored.

## Choosing scopes

| Scope            | Lets Claude                                                                                  | Default     |
| ---------------- | -------------------------------------------------------------------------------------------- | ----------- |
| `vault:read`     | Search and list items, folders and collections; see item metadata without any secret values. | on, fixed   |
| `vault:reveal`   | Read one secret field of one item per call: a password, a TOTP code, notes, a hidden field.  | on          |
| `vault:generate` | Generate random passwords and passphrases; nothing is stored.                                | on          |
| `vault:write`    | Create, update and trash items; create folders.                                              | not offered |

`vault:write` is only offered when the deployment sets `VAULTGATE_ENABLE_WRITE_SCOPE=true`. A
sensible first connection is `vault:read` plus `vault:generate`, adding `vault:reveal` only once
you have seen how Claude uses the vault. Full tool-by-tool detail is in
[Tools and scopes](tools-and-scopes.md).

## Tokens

Access tokens live one hour (`VAULTGATE_ACCESS_TOKEN_TTL`, 5 minutes to 24 hours). Claude
refreshes them silently with a refresh token that lives 30 days
(`VAULTGATE_REFRESH_TOKEN_TTL`, 1 hour to 365 days) and is rotated on every use; an old refresh
token presented twice revokes the whole family. After 30 days without use you are asked to
connect again.

## Revoking

Sign in at `https://<host>/account`. **Connected clients** lists each client with its
permissions, when it connected and when it was last used. **Disconnect** revokes the consent and
every access and refresh token issued under it; Claude's next call fails with `401` and the
connector shows as needing reconnection. Revoking is a sensitive action, so vaultgate asks you to
confirm your password first if you have not done so in the last five minutes.

Removing the connector on the Claude side deletes Claude's copy of the tokens but does not tell
vaultgate. Do both when you mean to cut access.

## Troubleshooting

**Claude asks to connect again and again (a 401 loop).** Claude is receiving `401` on every
request after authorization. Causes, in order of likelihood:

- `VAULTGATE_PUBLIC_URL` does not match the URL Claude uses. Tokens are bound to the canonical
  resource `${VAULTGATE_PUBLIC_URL}/mcp`, and the issuer in the metadata is the public URL; if
  the proxy serves a different host, or `http` instead of `https`, every token is rejected.
  Set the public URL to exactly the `https://` origin you typed into Claude and reconnect.
- The proxy strips the `Authorization` request header or the `WWW-Authenticate` response
  header. See [Reverse proxy](reverse-proxy.md).
- `VAULTGATE_TRUST_PROXY` is unset behind a proxy, so vaultgate sees `Host` or `X-Forwarded-Host`
  values that do not match the public URL and answers `403`.
- The consent was revoked on the account page. Reconnect.

**`redirect_uri` mismatch, or an "Authorization request rejected" page.** vaultgate compares the
redirect URI Claude sends at authorize time with the one it registered, exactly. If Anthropic
changes its redirect host, Claude re-registers; removing and re-adding the connector forces a
fresh registration. A request whose redirect URI cannot be trusted is answered with an HTML error
page rather than a redirect, so no code can leak.

**`insufficient_scope`.** A tool needs a scope the token does not carry: either you unticked it
at consent, or the deployment has since disabled `vault:write`. vaultgate answers `403` and lists
every scope the call needs. Disconnect on the account page and connect again, ticking the scope.
Tools outside the token's scopes are not even listed, so Claude normally does not try them; the
exception is `create_item`/`update_item` with an explicit `password`, which additionally needs
`vault:reveal`.

**`vault_unavailable` in tool results.** The vault is not unlocked; see
[First run § When `vault` keeps failing](first-run.md#when-vault-keeps-failing).

**Rate limited (`429`).** A token may make 120 tool calls per minute. Claude backs off by itself.
