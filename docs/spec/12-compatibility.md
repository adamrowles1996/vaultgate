# 12 Compatibility

## 12.1 Protocol

| Item                 | Supported                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| MCP protocol version | `2026-07-28` (primary); earlier versions the SDK negotiates, down to `2025-06-18`.                                           |
| Transport            | Streamable HTTP. No SSE-only legacy transport, no stdio.                                                                     |
| Authorization        | OAuth 2.1 (draft-ietf-oauth-v2-1-13), RFC 6750, 8414, 8707, 9728, 9207, 7591, 7009, Client ID Metadata Documents (draft-00). |
| Client registration  | CIMD, pre-registered, DCR (public clients only).                                                                             |
| Token formats        | Opaque reference tokens only. No JWT access tokens.                                                                          |

## 12.2 Clients

Verified in the compatibility suite before each release (manual checklist with
recorded evidence in the release PR):

| Client                        | Registration path            | Notes                                                                                                                                         |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude (web, desktop, Cowork) | DCR today; CIMD when shipped | Custom connector with the standard OAuth flow. Connections originate from Anthropic infrastructure, so the server must be publicly reachable. |
| Claude Code                   | DCR / CIMD                   | `claude mcp add --transport http …`                                                                                                           |
| Codex CLI and cloud           | DCR                          |                                                                                                                                               |
| MCP Inspector                 | DCR                          | Used in CI for a scripted handshake.                                                                                                          |
| VS Code, Cursor               | DCR                          |                                                                                                                                               |

### 12.2.1 Form-mode elicitation

A target with `policy.confirm_writes` (ACT-41) is usable only from a client that renders
form-mode elicitation on protocol revision `2026-07-28`. ACT-48 explains why an older negotiated
revision cannot be served in this deployment model at all, whatever the client supports, so the
question below is always asked of a client on `2026-07-28`.

A row is filled in **only from a run someone performed and recorded**: the client, its version,
the date and what the operator saw. "Not yet verified" is the correct entry until then, and a
client is never marked supported because its documentation or its SDK says it should be. A client
that does not render the prompt is not a defect in vaultgate: the call is refused with
`confirmation_unavailable` (ACT-48) and the operator's remedy is a different client or
`confirm_writes: false` with the review of ACT-63.

| Client                         | Form-mode elicitation on `2026-07-28`                                                                   | Evidence                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@modelcontextprotocol/client` | Yes — renders the ACT-42 request, returns the `ElicitResult` and retries with the echoed `requestState` | `src/mcp/tools/actions-elicitation.test.ts`, in CI on every pull request; the reference implementation |
| Claude Code                    | Not yet verified                                                                                        | —                                                                                                      |
| MCP Inspector                  | Not yet verified                                                                                        | —                                                                                                      |
| Claude (web, desktop, Cowork)  | Not yet verified                                                                                        | —                                                                                                      |
| Codex CLI and cloud            | Not yet verified                                                                                        | —                                                                                                      |
| VS Code, Cursor                | Not yet verified                                                                                        | —                                                                                                      |

The SDK row is the only one backed by a run as at this release, and the SDK is a library rather
than an agent a human sits in front of: it evidences the server's half of the exchange and
nothing about any product's user interface. Which revision each product negotiates, and whether
it renders the prompt, is unverified — not assumed either way.

## 12.3 Bitwarden servers

| Server                | Supported | Notes                                                                |
| --------------------- | --------- | -------------------------------------------------------------------- |
| bitwarden.com (US)    | yes       | default                                                              |
| bitwarden.eu          | yes       | server `bitwarden.eu` (account page or `VAULTGATE_BW_SERVER`)        |
| Self-hosted Bitwarden | yes       | server `https://…` (account page or `VAULTGATE_BW_SERVER`)           |
| Vaultwarden           | yes       | server `https://…` (account page or seed); personal API key required |

- **COMPAT-1** The minimum Bitwarden CLI version is recorded in `src/bitwarden/versions.ts`; the
  release pinned in the Dockerfile and in `install.sh` is kept equal, and at or above that
  minimum, by a test.

## 12.4 Runtime

- **COMPAT-2** Node 26 or newer (the line that becomes LTS on 28 October 2026; `node:sqlite` is
  stable there). Older lines are not supported. Linux x64 and arm64. macOS works for development.

## 12.5 Backwards compatibility promises

- Tool names, scope names, environment variable names and the database schema are stable within
  a major version. Removing or renaming any of them is a major release.
- The `/.well-known` documents and OAuth endpoints only gain fields.
