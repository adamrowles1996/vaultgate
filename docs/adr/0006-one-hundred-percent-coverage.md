# ADR 0006: 100% coverage with no ignore hints

Date: 2026-09-22. Status: accepted. Amended 2026-09-23: `src/cli.ts` added as the second exclusion.

## Context

Coverage thresholds below 100% invite the untested 5% to be exactly the error paths in the
token endpoint. Ignore hints make 100% meaningless.

## Decision

vitest thresholds are 100% for statements, branches, functions and lines over `src/**`.
Coverage ignore comments are forbidden. The process entrypoints (`src/main.ts` and `src/cli.ts`)
are the only exclusions; the CI smoke job boots the real server and runs the audit-export CLI
against a fresh data directory. Untestable code is restructured (dependency injection of `fetch`,
DNS, clocks and the vault client) until it is testable.

## Consequences

- Tests are a design constraint, which keeps modules small and injectable.
- Every pull request either keeps 100% or explains, in the PR, why the threshold must change.
