# ADR 0003: The vault is reached through a managed loopback `bw serve`

Date: 2026-09-22. Status: accepted.

## Context

Options for reading a personal Bitwarden vault: the official CLI (`bw`) per call, the CLI's
persistent `bw serve` REST API, or the internal SDK used by the Bitwarden clients (not published
for third-party vault access; the published SDK targets Secrets Manager). Vaultwarden must work
too.

## Decision

Run `bw serve` as a child process bound to `127.0.0.1` on a random free port, owned and
supervised by vaultgate. Log in with a personal API key, unlock with the master password, sync
on a schedule. All vault operations go through a typed client over that loopback API, validated
with zod.

## Consequences

- Works unchanged against bitwarden.com (US/EU), self-hosted Bitwarden and Vaultwarden.
- The CLI binary is a runtime dependency: pinned and checksummed in the container image, version
  gated at start-up.
- `bw serve` has no authentication; loopback binding and running vaultgate alone in its container
  are the controls (documented in the threat model as a residual risk).
- Process spawning is confined to one module by lint so the boundary stays auditable.
