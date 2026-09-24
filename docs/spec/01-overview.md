# 01 Overview

## 1.1 Purpose

vaultgate is a self-hosted, remote [Model Context Protocol](https://modelcontextprotocol.io)
server that lets AI agents use the credentials in a Bitwarden vault without ever
seeing them. It is the piece that is missing between hosted agent products
(Claude web, Claude Cowork, Claude Code, Codex, IDE assistants) and the
credentials their work needs:

- Hosted agents connect only to remote MCP servers over HTTPS with OAuth. They
  cannot run a local stdio process on your machine.
- A credential an agent reads to use it ends up in the model's context, the
  chat transcript, the client's logs and the command line the agent builds.
  Revoking the agent does not take the value back.
- Bitwarden's official MCP server is stdio-only and its README says it must
  never be hosted publicly. That is the right call for that design: it has no
  authorization layer.

vaultgate supplies both halves. It is simultaneously an **OAuth 2.1
authorization server** (it authenticates the human and issues tokens), an
**OAuth 2.1 resource server** (it validates tokens on every MCP request), and an
**MCP server** whose tools do two things: the **actions layer** (section 13)
performs typed operations at operator-defined targets with a credential vaultgate
fetches and the agent never receives, and the **vault tools** (section 6) read
metadata and, through one audited door, a single secret field when a value
really must be read. The vault itself is reached through a managed,
loopback-only `bw serve` process.

## 1.2 Personas

| Persona      | Description                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator** | The person who deploys vaultgate against their own vault and approves which agents may use it. In v1 there is exactly one operator account per deployment. |
| **Agent**    | An MCP client acting for the operator: Claude, Codex, an IDE, a script. It holds an access token and nothing else.                                         |
| **Attacker** | Anyone else on the internet, a compromised agent, or a compromised token. See the threat model.                                                            |

## 1.3 Design principles

1. **The agent never holds credentials, and need not read them to use them.**
   Only the vaultgate process knows the master password and API key. Agents
   hold short-lived, scoped, audience-bound bearer tokens that vaultgate can
   revoke. The actions layer (section 13, ADR 0007) performs an operation with
   a credential the agent never receives and scrubs every injected value from
   the result; it is off unless the deployment enables it, connector by
   connector.
2. **Secrets leave the server only through one door.** Exactly one tool
   (`get_secret`) returns secret material, it requires its own scope, and
   every call is audit-logged. Every other vault tool returns metadata, and no
   action returns an injected value.
3. **No arbitrary remote code execution.** No tool evaluates an expression,
   reads a file on the vaultgate host or makes an arbitrary HTTP request, and
   nothing ever executes on the vaultgate host. Actions run only at
   operator-defined targets, under the operator's allowlists: `ssh_run` and
   `winrm_run` run one command on one configured host (an allow-any-command
   target needs a per-target flag and the deployment's consent, 13.1), and an
   agent argument changes what runs, never where or as whom. Lint rules confine process
   spawning to one module.
4. **Standards, not inventions.** OAuth 2.1, RFC 9728, RFC 8414, RFC 8707,
   RFC 7591, RFC 7009, RFC 9207, Client ID Metadata Documents and the MCP
   authorization specification, implemented as written and tested against
   their normative statements.
5. **Loopback by default, public by decision.** Nothing listens on a public
   interface until the operator sets a public URL, and `bw serve` never
   listens anywhere but loopback.
6. **Boring, small, observable.** One process, one SQLite file, structured
   logs, health probes, an audit trail. No queues. The sidecars are optional
   and run in their own containers so the core image never carries them: the
   `browser` connector's Chromium (ACT-91) and the `code` connector's index
   (ACT-113).
7. **Spotless is a feature.** 100% test coverage, type-checked lint,
   size-capped files, pinned supply chain, conventional history.

## 1.4 Non-goals (v1)

- Multiple vaults or multiple Bitwarden accounts per deployment.
- Bitwarden Secrets Manager (a different product with its own SDK).
- Organisation administration (members, groups, policies, billing).
- Acting as an OpenID Connect provider for other applications.
- Attachments, Sends, device approval and passkey storage.
- Serving as a general-purpose OAuth server for non-MCP resources.

Tracked for later versions (see `PLAN.md`): passkey (WebAuthn) operator login,
upstream OIDC operator login, a PostgreSQL store, Prometheus metrics.

## 1.5 Glossary

| Term               | Meaning                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| AS                 | OAuth authorization server: the part of vaultgate that issues tokens.                      |
| RS                 | OAuth resource server: the part of vaultgate that validates tokens on `/mcp`.              |
| PRM                | Protected Resource Metadata (RFC 9728), served at `/.well-known/oauth-protected-resource`. |
| CIMD               | Client ID Metadata Document: an HTTPS URL used as `client_id`, pointing at JSON metadata.  |
| DCR                | Dynamic Client Registration (RFC 7591), `POST /oauth/register`.                            |
| Canonical resource | `${VAULTGATE_PUBLIC_URL}/mcp`, the RFC 8707 resource identifier for this server.           |
| Operator session   | The browser cookie session of the logged-in operator, used only by the consent UI.         |
| Consent            | A stored decision that a given client may hold tokens with a given scope set.              |
| Token family       | A refresh token and all of its rotated descendants; revoked together on replay.            |
| bw serve           | The Bitwarden CLI's local REST server, run as a managed child process on loopback.         |
