# ADR 0001: TypeScript on Node 24 with native type stripping and `node:sqlite`

Date: 2026-09-22. Status: accepted.

## Context

The MCP TypeScript SDK v2 (2.0.0, targeting the 2026-07-28 specification) is the most complete
server implementation available, and the lint rules we want to enforce are typescript-eslint
rules. Node 24 is the active LTS line; it runs `.ts` files directly (type stripping) and ships a
stable `node:sqlite`. Node 22 still prints an experimental warning for `node:sqlite`.

## Decision

- Language: TypeScript 5.9 in `strict` mode with `erasableSyntaxOnly` so the source is valid for
  Node's type stripping (no enums, namespaces or parameter properties).
- Runtime: Node ≥ 24. `npm run dev` runs the source directly; production runs `tsc` output.
- Storage: `node:sqlite`, no native addon.
- Package manager: npm with a committed lockfile and exact versions.

## Consequences

- One runtime to support; Node 22 users must upgrade.
- No build step in development; the CI smoke job proves both the source and the build boot.
- typescript-eslint does not yet support TypeScript 7; we stay on 5.9 until it does.
