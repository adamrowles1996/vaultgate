# ADR 0001: TypeScript on Node 26 with native type stripping and `node:sqlite`

Date: 2026-09-22. Status: accepted.

## Context

The MCP TypeScript SDK v2 (2.0.0, targeting the 2026-07-28 specification) is the most complete
server implementation available, and the lint rules we want to enforce are typescript-eslint
rules. Node runs `.ts` files directly (type stripping) and ships `node:sqlite` without an
experimental warning from Node 24 onwards. Node 26 is the newest release line and becomes LTS on
28 October 2026, before this project's first usable release.

The runtime major is the one dependency Dependabot cannot manage alone: `.nvmrc`, `engines`, the
container base image and `@types/node` must move together. Tracking the newest line, rather than
pinning `@types/node` behind an ignore rule, keeps that coupling explicit and current.

## Decision

- Language: TypeScript 5.9 in `strict` mode with `erasableSyntaxOnly` so the source is valid for
  Node's type stripping (no enums, namespaces or parameter properties).
- Runtime: Node ≥ 26 (`.nvmrc`, `engines`, base image). `npm run dev` runs the source directly;
  production runs `tsc` output.
- `@types/node` follows the runtime major; Dependabot updates it like any other dependency.
- Storage: `node:sqlite`, no native addon.
- Package manager: npm with a committed lockfile and exact versions.

## Consequences

- One runtime to support; a new Node major is adopted by a single PR that moves `.nvmrc`,
  `engines`, the base image and `@types/node` together.
- No build step in development; the CI smoke job proves both the source and the build boot.
- typescript-eslint does not yet support TypeScript 7; we stay on 5.9 until it does.
