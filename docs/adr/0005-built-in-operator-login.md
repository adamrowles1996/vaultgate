# ADR 0005: Built-in operator account (password + TOTP) before passkeys and OIDC

Date: 2026-09-22. Status: accepted.

## Context

The operator must authenticate at the consent page. Requiring an external identity provider
would make a working installation depend on a tenant most individuals do not have. Passkeys
give the best sign-in experience but add a WebAuthn dependency and a large test surface.

## Decision

v1 ships a built-in operator account created on first run via a one-time bootstrap URL:
password (scrypt) plus TOTP (RFC 6238, implemented on `node:crypto`) with recovery codes.
Identity is behind an interface so passkeys (first post-1.0 milestone) and upstream OIDC can be
added without touching the OAuth layer.

## Consequences

- Zero external dependencies for login; all security-sensitive code is in-tree and tested with
  RFC vectors.
- Password handling, rate limiting and session management are our responsibility and are
  specified in detail (spec 04).
