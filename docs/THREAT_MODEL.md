# Threat model

## Assets

| Asset                                   | Impact if compromised                                              |
| --------------------------------------- | ------------------------------------------------------------------ |
| Bitwarden master password and API key   | Total vault compromise. Held only in vaultgate process memory.     |
| Unlocked `bw serve` session             | Total vault read/write from the host. Loopback only.               |
| Access and refresh tokens               | Scoped vault access for their lifetime. Opaque, hashed, revocable. |
| Operator password, TOTP secret, session | Ability to approve new agents. Hashed / encrypted / hashed.        |
| `VAULTGATE_SECRET_KEY`                  | Decrypts stored TOTP secrets. No vault access by itself.           |
| Audit log                               | Forensic integrity.                                                |
| Vault contents in transit               | Leak to an agent beyond its scope.                                 |

## Trust boundaries

1. Internet ↔ reverse proxy / ingress (TLS terminates here).
2. Proxy ↔ vaultgate HTTP listener (private network).
3. vaultgate ↔ `bw serve` (loopback inside the same host or container network namespace).
4. `bw serve` ↔ Bitwarden server (HTTPS, Bitwarden's own end-to-end encryption).
5. vaultgate ↔ SQLite file and `bw` app-data on disk.
6. Operator's browser ↔ vaultgate (cookie session).
7. Agent ↔ vaultgate (bearer token).

## Attackers

| Attacker                           | Capabilities                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Internet stranger**              | Sends any HTTP request; controls DNS names and hosts CIMD documents.                               |
| **Malicious or compromised agent** | Holds a valid token; crafts arbitrary tool inputs; may be prompt-injected.                         |
| **Phishing operator**              | Tricks the operator into approving a consent for an attacker-controlled client.                    |
| **Host-local attacker**            | Reads files or connects to loopback ports on the host. Out of scope beyond documented mitigations. |
| **Malicious dependency**           | Supply-chain compromise of an npm package or GitHub Action.                                        |

## Threats and mitigations

| ID  | Threat                                                   | Mitigation (spec ids)                                                                                                                           |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Token theft from an agent's storage                      | Short TTL, opaque + hashed, audience-bound, revocable, refresh rotation with family revocation (OAUTH-24, 25, 29, 32)                           |
| T2  | Authorization code interception                          | PKCE S256 mandatory, single use, 5 min TTL, exact redirect match (OAUTH-7, 19, 21…23)                                                           |
| T3  | Token passthrough / confused deputy                      | Only self-issued tokens accepted; bearer never forwarded (OAUTH-34); bw session is separate                                                     |
| T4  | Mix-up attack across authorization servers               | `iss` in authorization responses (OAUTH-19, RFC 9207)                                                                                           |
| T5  | Open redirect via `redirect_uri`                         | Registered URIs only, HTTPS or loopback, exact match; errors render, never redirect (OAUTH-6, 14)                                               |
| T6  | SSRF via CIMD `client_id` URL                            | HTTPS only, DNS pre-resolution against private ranges, redirect cap, timeout, size cap (OAUTH-8)                                                |
| T7  | Localhost impersonation in CIMD                          | Consent shows redirect host with an explicit warning (OAUTH-13)                                                                                 |
| T8  | Consent phishing (attacker client with a plausible name) | Consent shows registration mechanism and full host; operator re-auth for sensitive actions (ID-15)                                              |
| T9  | Credential stuffing on `/login`                          | scrypt, backoff rate limits, identical failure messages, TOTP second factor (ID-6, 12, 13)                                                      |
| T10 | TOTP replay                                              | Last-accepted-step tracking (ID-10)                                                                                                             |
| T11 | Session fixation / CSRF on consent                       | Session rotation on login, `__Host-` cookie, SameSite, Origin check, synchroniser token (ID-14, 16, 18)                                         |
| T12 | XSS on operator pages                                    | No JavaScript, strict CSP, server-rendered templates with escaping (ID-19)                                                                      |
| T13 | Secrets leaking through logs or errors                   | Redaction backstop, error masking, canary tests, audit payloads secret-free (OPS-1, MCP-9, 13)                                                  |
| T14 | Agent exfiltrating the whole vault                       | Search cap 50, secrets only via `get_secret` per field, per-token rate limit, full audit (MCP-5, 9, 13)                                         |
| T15 | Prompt-injected agent writing malicious items            | `vault:write` off by default; no permanent delete; audit; operator revocation (OAUTH-16, MCP-15)                                                |
| T16 | Remote code execution through a tool                     | No such tool exists; `child_process` lint-confined; tool schemas closed (ARCH-2, MCP-9)                                                         |
| T17 | DNS rebinding to a loopback-bound dev instance           | Host and Origin validation on `/mcp` (MCP-3)                                                                                                    |
| T18 | Host-local attacker reading the SQLite file              | Hashes/ciphertext only (STORE-4); file mode 0600; container read-only rootfs                                                                    |
| T19 | Host-local attacker calling `bw serve` on loopback       | Documented residual risk; container isolation; run nothing else in the container                                                                |
| T20 | Supply-chain compromise                                  | Exact pins, lockfile, SHA-pinned actions, harden-runner, dependency review, CodeQL, Scorecard, signed images with SBOM and provenance (QG-4…10) |
| T21 | Denial of service by bulk DCR or token requests          | Per-IP limits and body caps (OAUTH-11, 28, MCP-4)                                                                                               |
| T22 | Stale CIMD document after a client rotates redirect URIs | Bounded cache TTL; forced refetch on redirect mismatch (OAUTH-10)                                                                               |

## Residual risks (accepted, documented)

- Anything with root on the host can read process memory and therefore the master password.
  vaultgate is designed to be the only workload on its host or container.
- `bw serve` has no authentication of its own; loopback binding and network-namespace isolation
  are the controls. Running vaultgate with `--network host` in Docker is unsupported.
- A hosted agent product's own token storage is outside this model; short access-token TTL and
  revocation limit the blast radius.
