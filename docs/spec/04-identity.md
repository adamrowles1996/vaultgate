# 04 Identity: operator account and sessions

The operator is authenticated by vaultgate itself. v1 ships one identity
provider, the built-in operator account (password + TOTP). The provider is
behind an interface so a passkey provider and an upstream OIDC provider can be
added without touching the OAuth layer (see `PLAN.md`).

## 4.1 First-run bootstrap

- **ID-1** When the store contains no operator, start-up generates a 32-byte bootstrap token,
  stores its SHA-256 with a 30 minute expiry, and logs exactly once:
  `Open ${PUBLIC_URL}/setup?token=… to create the operator account`. The token is logged at
  `info` level and never again; a restart mints a new one.
- **ID-2** `VAULTGATE_BOOTSTRAP_TOKEN` MAY preset the token (for automated installs). It is
  consumed on first use like a generated one.
- **ID-3** `GET /setup` without a valid token renders a generic page with no hint of validity.
  `POST /setup` with a valid token, an e-mail address, a password passing ID-5 and a verified
  TOTP code creates the operator, invalidates the token, issues 8 recovery codes (shown once),
  and starts a session. The e-mail address is the operator's login identifier: it is trimmed,
  lower-cased and shape-checked (exactly one `@`, a non-empty local part, a dot inside the domain,
  no whitespace, at most 254 characters); nothing is resolved or delivered, so a deployment needs
  no mail. It is stored lower-cased, unique case-insensitively, and can be changed from the
  account page (`POST /account/email`, ID-15). It is not a secret: audit events for setup, login
  and address changes carry it in `details.email`.
- **ID-4** Once an operator exists, `/setup` answers `404` for every request.

## 4.2 Password

- **ID-5** Minimum 12 characters, maximum 256, no composition rules (NIST SP 800-63B). The
  submitted password is checked against a bundled list of the 10 000 most common passwords
  (compressed, offline) and rejected if present.
- **ID-6** Hashing: scrypt (`node:crypto`), N = 2^17, r = 8, p = 1, 32-byte random salt, 64-byte
  output, stored as `scrypt$N$r$p$salt$hash` so parameters can be raised later and hashes
  upgraded on next login.
- **ID-7** Comparison is constant-time (`timingSafeEqual`).

## 4.3 TOTP

- **ID-8** RFC 6238 with HMAC-SHA1, 6 digits, 30 s step, implemented on `node:crypto` (no
  dependency) and verified against the RFC 6238 Appendix B test vectors.
- **ID-9** Enrolment shows an `otpauth://totp/vaultgate:<account>?secret=…&issuer=vaultgate` URI
  as text together with the base32 key for manual entry; `<account>` is the operator's e-mail
  address, or `operator` at first run, when none has been submitted yet. (v1 renders no QR image: a QR encoder would
  be a dependency, and every authenticator app accepts a manual key. A QR image is a post-1.0
  option once an in-tree encoder is justified.) The secret is 20 random bytes, stored encrypted at rest with a key derived
  from `VAULTGATE_SECRET_KEY` (HKDF, AES-256-GCM), never logged.
- **ID-10** Verification accepts the current step and one step either side and MUST reject a code
  whose step is ≤ the last accepted step (replay protection), persisted per operator.
- **ID-11** Recovery codes: 8 codes of 10 base32 characters, stored as SHA-256, each single use,
  regenerable from the account page after re-authentication.

## 4.4 Login

- **ID-12** Two-step form: e-mail address and password, then TOTP or recovery code. Both steps
  carry a synchroniser token. Failure messages are identical for an unknown or malformed e-mail
  address, a wrong password and a wrong code, and an unknown address costs the same password
  work as a wrong password.
- **ID-13** Rate limiting: after 5 failures within 15 minutes for an IP or the account, further
  attempts are delayed exponentially (1 s, 2 s, 4 s … capped at 60 s) and counted in the audit
  log. The account is keyed by the submitted e-mail address, lower-cased (`email:<address>`),
  whether or not it exists; the IP by `ip:<address>`. There is no permanent lockout
  (denial-of-service safety).
- **ID-14** Successful login rotates the session id, records IP and user agent, and writes an
  audit event. Sessions live 12 hours absolute, 1 hour idle; both refresh on activity up to the
  absolute limit.
- **ID-15** Re-authentication (password only) is required within 5 minutes before: revoking a
  client, regenerating recovery codes, changing the password, changing the e-mail address,
  rotating TOTP, enabling `vault:write` from the account page, changing the vault connection
  (ID-25).

## 4.5 Session cookie

- **ID-16** Name `__Host-vg_session`, attributes `HttpOnly; Secure; SameSite=Lax; Path=/`.
  The value is 32 random bytes base64url; only its SHA-256 is stored. When `PUBLIC_URL` is
  `http://localhost…` in development the `__Host-` prefix and `Secure` are dropped and a warning is
  logged at start-up.
- **ID-17** Logout deletes the server-side session and clears the cookie.

## 4.6 CSRF and browser hardening

- **ID-18** Every state-changing browser route requires: `SameSite=Lax` cookie, an `Origin` (or
  `Sec-Fetch-Site: same-origin`) header matching `PUBLIC_URL`, and a per-session synchroniser token
  in the form body. Any missing element is a `403` with an audit event.
- **ID-19** HTML pages are served with a `Content-Security-Policy` of
  `default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`.
  Pages contain no JavaScript. Styling is a single static stylesheet.
- **ID-20** `Strict-Transport-Security: max-age=31536000; includeSubDomains` is set when
  `PUBLIC_URL` is `https`.

## 4.7 Identity provider interface

```ts
interface IdentityProvider {
  readonly kind: 'local' | 'oidc' | 'passkey';
  /** Returns the authenticated operator id, or a redirect/challenge to complete. */
  authenticate(request: Request, session: SessionState): Promise<AuthOutcome>;
}
```

- **ID-21** The OAuth authorize flow depends only on `SessionState.operatorId`; it never inspects
  which provider produced it.

## 4.8 Verification

- **ID-22** Every browser flow in this section (setup → recovery codes → logout → login with TOTP
  or a recovery code → re-authentication → password change, e-mail change, TOTP rotation,
  recovery-code regeneration, and the ID-26 legacy path) is exercised in-process through `app.request()` with a cookie jar in
  `src/test-support/browser.ts`, so no headless browser is needed in CI (ARCH-5). Pages carry no
  JavaScript, so there is no client-side behaviour a real browser would add.

## 4.9 HTTP routes

| Route                                             | Purpose                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                                           | **ID-23** `303` to `/account` when the request carries a live operator session, otherwise to `/login`; `no-store`.       |
| `GET /setup`, `POST /setup`                       | First-run bootstrap (ID-1 to ID-4).                                                                                      |
| `GET /login`, `POST /login`, `POST /login/verify` | The two-step login (ID-12).                                                                                              |
| `POST /logout`                                    | Ends the session (ID-17).                                                                                                |
| `GET /account`, `POST /account/*`                 | The account page and its ID-15 actions, including `POST /account/email` (ID-3, ID-26) and `POST /account/vault` (ID-25). |
| `GET /static/vaultgate.css`                       | The single stylesheet (ID-19).                                                                                           |

- **ID-25** The account page has a "Vault connection" section: the status for any signed-in
  operator (whether credentials are configured and where they came from, the server, the masked
  account e-mail from `bw serve`'s `/status`, readiness, last sync) and, after re-authentication
  (ID-15), a form with the server (optional; `bitwarden.eu` or an `https://` URL, validated by the
  same primitive as `VAULTGATE_BW_SERVER`), the API key client id, the client secret and the master
  password. Secret fields are always rendered empty and a stored secret is never echoed; a blank
  secret keeps the one in use (both are required while nothing is configured). `POST /account/vault`
  passes the ID-18 checks and ID-15, then stores the connection (STORE-9) and switches the backend to
  it in one step (VAULT-18): there is no separate "test" path, saving is the test. Success redirects
  to the section with a notice; a failure re-renders the form with the backend's fixed reason
  (`400` for input the page itself rejects, `503` when the backend refuses the connection) and
  without either secret. Every attempt records `vault.settings_updated` (`ok`/`failure`, the server
  and, on failure, the reason; never a secret). When setup completes (ID-3) while no connection is
  configured, the recovery-codes page ends with a link to this section.
- **ID-24** Any other path answers `404`. When the `Accept` header prefers `text/html` the body is
  a short page rendered by the same escaping template and stylesheet as every other page, under
  the ID-19 policy and `Cache-Control: no-store`; otherwise (JSON accepted, `*/*`, or no `Accept`
  at all) the body is `{"error":"not_found"}`. The `/mcp` endpoint and the `.well-known` metadata
  routes (spec 06) produce their own answers and headers and are not affected.

## 4.10 Accounts created before e-mail identification

- **ID-26** An operator row written before the `operator-email` migration (`operators.email`
  NULL, see spec 07) is in _legacy mode_ until it sets an address. In legacy mode `GET /login` asks for the password only
  (the one account is implied; the form reveals nothing beyond the deployment's age), ID-13
  counts the account by `operator:<id>`, and the ID-12 second step is unchanged. Once signed in,
  `/account` is replaced by a "Set your e-mail address" page: after re-authentication (ID-15)
  the only action offered, and the only `POST /account/*` accepted besides
  `/account/reauthenticate` and `/logout`, is `POST /account/email`. Every other account action
  answers `403` with a `request.denied` audit event. As soon as an address is set, login asks
  for e-mail address and password like any other deployment. The audit events of a legacy login
  carry no `details.email`, because there is none to carry.
