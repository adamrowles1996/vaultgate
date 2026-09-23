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
