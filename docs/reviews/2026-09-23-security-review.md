# Independent security review, 2026-09-23

An adversarial review of `main` at v0.1.0-rc.4 by a reviewer with no involvement in the
implementation, working from a fresh clone and a local instance. Reproduced verbatim; the fixes
landed in the release that follows (see CHANGELOG). Findings 1 to 3 were required before approval.

---

The clone is deleted and the server is stopped (the only "main.ts" match was my own grep command). Report follows.

---

## Security review: adamrowles1996/vaultgate (v0.1.0-rc.4)

Independent adversarial review of the OAuth 2.1 authorization server, identity layer, MCP surface, Bitwarden backend, crypto, deployment artefacts and dependencies. I read the code and tests, booted a local instance with placeholder config, and ran concrete attacks against the auth surface. Findings below with file:line, severity, and whether I verified them or judged them plausible from the code.

### Findings

#### 1. CIMD SSRF guard is TOCTOU / DNS-rebinding bypassable — HIGH (code-verified gap; blind-SSRF impact)

`src/oauth/clients/ssrf-fetch.ts:89-101`. `fetchOnce` calls `assertPublicHost(url, options.lookup)` (which resolves the hostname via the injected `dns.lookup` and checks every address against the private-range blocklist), then immediately calls the global `options.fetch(url.href, …)`. The `fetch` (undici) performs its **own, independent DNS resolution** at connect time — nothing pins the socket to the address that was validated. An attacker fully controls the `client_id` URL and therefore its DNS; a low-TTL record that answers with a public IP for the guard's lookup and a private IP (e.g. `169.254.169.254`, `127.0.0.1`, RFC1918) for undici's lookup defeats the check. Each redirect hop (`follow`, line 112-123) has the same flaw. This is precisely the mitigation the threat model claims is in place ("T6 … DNS pre-resolution against private ranges", `docs/THREAT_MODEL.md:44`) — pre-resolution without connection pinning is not a mitigation.

- Reachable unauthenticated at `GET /oauth/authorize` (a CIMD `client_id` triggers `resolveCimd` → `safeFetch`), so an Internet stranger can drive it against a host that holds a Bitwarden vault.
- Impact bounded: responses are only returned to the caller when they parse as a valid CIMD document whose `client_id` equals the URL (`cimd-document.ts:403-415`), so this is primarily **blind** SSRF (internal reachability, port/timing probing, GET-driven side effects). Volume is capped by a process-wide 30/min CIMD limiter. Still, blind SSRF from the vault host into the internal network / cloud-metadata surface is serious.
- Fix: resolve once, then connect to the validated IP with `Host`/SNI preserved — a custom `lookup`/undici dispatcher pinned to the vetted address (or an allowlisted resolver), re-validating on every redirect. Do not let a second resolution occur.

#### 2. `/oauth/authorize` rate limit is keyed on an attacker-controlled cookie — MEDIUM (verified exploitable)

`src/oauth/authorize-shared.ts:120-130` (`rateLimitKey`) → for an unauthenticated request the key is `bindingCookie(context) ?? ip`, and the binding cookie `vg_authz` is a plain client-supplied value (`ensureBindingCookie`, lines 73-92). An attacker who rotates `vg_authz` on each request gets a fresh token bucket every time, so the documented 30/min authorize limit (spec §10.4) never triggers.

- Verified against the local instance: 40 requests with distinct `vg_authz` cookies → all `400`, never `429`; 40 requests with a single cookie (or no cookie, IP-keyed) → `429` after 30. Bypass confirmed.
- Secondary effect: the token-bucket `Map` in `createRateLimiter` (`rate-limit.ts:400-433`) grows one entry per distinct key and `prune` scans all entries on every call (O(n) per request), so a flood of distinct keys adds CPU/memory pressure (bounded by the ~2 s refill window, so a mild amplifier, not a standalone DoS).
- Fix: for anonymous authorize requests, key the limiter on the resolved client IP (never on a value the client chooses); only use the session id hash once a real session exists.

#### 3. Leftmost `X-Forwarded-For` is trusted → audit-log IP spoofing and IP-throttle/rate-limit evasion — MEDIUM (code-verified; affects default deploys)

`src/identity/guards.ts:35-39` and `src/mcp/request-guards.ts:69-72` both take `xff.split(',',1)[0]` — the **leftmost** entry — as the client IP whenever `trust_proxy` is on. The shipped reverse-proxy configs use `$proxy_add_x_forwarded_for` (`deploy/proxy/nginx.conf:29`) / Caddy's appended XFF, which _append_ the real peer and leave any client-supplied XFF entries to the left. Both shipped deployments set `VAULTGATE_TRUST_PROXY=true` (`docker-compose.yml:114`, `deploy/systemd/vaultgate.env.example:32`). So a client sending `X-Forwarded-For: 1.2.3.4` controls the value used for:

- the recorded IP in every audit event (`login.*`, `consent_*`, `token_*`, MCP tool calls) — trail poisoning/repudiation;
- the `ip:` subject in the login/reauth throttle (`login-throttle.ts:595`) — spread guesses across forged IPs to dodge IP backoff (per-account backoff still applies);
- the IP key on the token/register/revoke limiters.
- Fix: parse XFF right-to-left, skipping a configured number of trusted proxy hops (or read a single trusted header the proxy sets), rather than taking the leftmost attacker-controllable entry. Document that the proxy must strip inbound XFF.

#### 4. `/oauth/revoke` has no rate limit — LOW (verified)

`src/oauth/routes.ts:51` / `src/oauth/revoke.ts:136-149`. Unlike token/register/authorize, the revocation endpoint is not wrapped in a limiter. Verified: 100 unauthenticated POSTs all returned `200`. Tokens are 256-bit random so this is not a guessing oracle, but it is an unauthenticated, unbounded DB-lookup endpoint (minor DoS) and inconsistent with the rest of the surface. Fix: apply the same per-IP limiter used by the token endpoint.

#### 5. `/readyz` exposes vault state unauthenticated — LOW/INFO

`src/http/app.ts:82-90` returns `vault.configured`, `vault.ready` and `lastSyncAt` with no auth. Minor operational disclosure (whether a vault is wired and last sync time). Consider gating detail behind the session or reducing to a boolean.

### Strongest aspects

This is unusually careful for a v0.1: PKCE is S256-only with constant-time verifier comparison and no `plain` downgrade; authorization codes are single-use via an atomic `UPDATE … WHERE used_at IS NULL` and a second redemption revokes the whole token family (`repositories/authorization-codes.ts:82-101`, `token.ts:288-311`); refresh tokens rotate with family-wide revoke-on-replay; every issued credential is stored only as a SHA-256 hash; `iss` (RFC 9207) and RFC 8707 `resource` binding are enforced on both authorize and token, closing mix-up/confused-deputy; redirect URIs are exact-match with the RFC 8252 loopback-port exception applied only to literal loopback; HTML is escaped through a single tagged-template layer under a strict `default-src 'none'` CSP (the DCR `client_name` XSS I tried is correctly neutralised on the consent page); scrypt (N=2^17) with rehash-on-login, constant-time compare, and equal-cost failure path for unknown accounts; secrets sealed with AES-256-GCM under per-purpose HKDF subkeys; `bw serve` runs on loopback with a scrubbed-env child, disposable credential buffers, and the container/systemd units are genuinely hardened (non-root, read-only rootfs, cap-drop, seccomp). Config defaults to loopback, enforces a ≥32-byte key, and `npm audit` is clean with fully pinned dependencies and a fail-closed token verifier.

### Verdict

Not yet — I would withhold approval for a security-conscious self-hoster until the network-facing issues are fixed, even though the core OAuth/crypto is sound. Required before approval:

1. **Finding 1 (SSRF/DNS-rebinding):** pin the CIMD connection to the validated IP; re-validate every redirect. This is the one that meaningfully undercuts a control the project claims to have, on a host that holds a vault.
2. **Finding 3 (XFF):** fix the leftmost-XFF parse so audit-trail IPs and IP-based throttles cannot be spoofed in the default proxied deployment.
3. **Finding 2 (authorize limiter key):** stop keying anonymous rate limits on a client-chosen cookie.

Findings 4 and 5 are reasonable fast-follows. With 1-3 addressed I would be comfortable recommending it.

Note on method/limits: findings 2 and 4 were verified live against a local unconfigured instance; finding 1 and 3 are code-verified structural gaps (I did not stand up a rebinding DNS server or a full proxy chain, but the absence of connection pinning and the leftmost-XFF parse are unambiguous in the source and the shipped configs). The clone was deleted at the end.
