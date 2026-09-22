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
  `POST /setup` with a valid token, a display name, a password passing ID-5 and a verified TOTP
  code creates the operator, invalidates the token, issues 8 recovery codes (shown once), and
  starts a session.
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
- **ID-9** Enrolment shows an `otpauth://totp/vaultgate:<name>?secret=…&issuer=vaultgate` URI as
  text together with the base32 key for manual entry. (v1 renders no QR image: a QR encoder would
  be a dependency, and every authenticator app accepts a manual key. A QR image is a post-1.0
  option once an in-tree encoder is justified.) The secret is 20 random bytes, stored encrypted at rest with a key derived
  from `VAULTGATE_SECRET_KEY` (HKDF, AES-256-GCM), never logged.
- **ID-10** Verification accepts the current step and one step either side and MUST reject a code
  whose step is ≤ the last accepted step (replay protection), persisted per operator.
- **ID-11** Recovery codes: 8 codes of 10 base32 characters, stored as SHA-256, each single use,
  regenerable from the account page after re-authentication.

## 4.4 Login

- **ID-12** Two-step form: password, then TOTP or recovery code. Both steps carry a synchroniser
  token. Failure messages are identical for unknown account, wrong password and wrong code.
- **ID-13** Rate limiting: after 5 failures within 15 minutes for an IP or the account, further
  attempts are delayed exponentially (1 s, 2 s, 4 s … capped at 60 s) and counted in the audit
  log. There is no permanent lockout (denial-of-service safety).
- **ID-14** Successful login rotates the session id, records IP and user agent, and writes an
  audit event. Sessions live 12 hours absolute, 1 hour idle; both refresh on activity up to the
  absolute limit.
- **ID-15** Re-authentication (password only) is required within 5 minutes before: revoking a
  client, regenerating recovery codes, changing the password, rotating TOTP, enabling
  `vault:write` from the account page.

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
  or a recovery code → re-authentication → password change, TOTP rotation, recovery-code
  regeneration) is exercised in-process through `app.request()` with a cookie jar in
  `src/test-support/browser.ts`, so no headless browser is needed in CI (ARCH-5). Pages carry no
  JavaScript, so there is no client-side behaviour a real browser would add.
