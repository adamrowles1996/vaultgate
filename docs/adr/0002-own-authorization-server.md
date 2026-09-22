# ADR 0002: vaultgate is its own OAuth 2.1 authorization server

Date: 2026-09-22. Status: accepted.

## Context

The MCP SDK v2 implements only the resource-server side (`requireBearerAuth`, metadata
responses). An authorization server must come from somewhere: an external identity provider
(Entra, Auth0, Keycloak) or the application itself. The target user is one person with one vault
who wants `docker compose up` to be a complete installation.

## Decision

vaultgate implements the authorization server in-process: metadata, client registration (CIMD,
DCR, pre-registered), authorize with a consent page, token issuance with PKCE and resource
indicators, refresh rotation and revocation. Tokens are opaque references stored as hashes in the
same SQLite database. The human is authenticated by a pluggable identity provider (ADR 0005).

## Consequences

- No external dependency for a working installation.
- The security-critical code is ours and is tested against the normative statements in the MCP
  authorization specification, RFC 6749/6750/7636/8707/9207/9700 and the CIMD draft.
- Supporting an upstream identity provider later is an identity-provider plug-in, not a change to
  the OAuth layer.
