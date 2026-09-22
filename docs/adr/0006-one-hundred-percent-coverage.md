# ADR 0006: 100% coverage with no ignore hints

Date: 2026-09-22. Status: accepted.

## Context

Coverage thresholds below 100% invite the untested 5% to be exactly the error paths in the
token endpoint. Ignore hints make 100% meaningless.

## Decision

vitest thresholds are 100% for statements, branches, functions and lines over `src/**`.
Coverage ignore comments are forbidden. The process entrypoint (`src/main.ts`) is the single
exclusion; it is exercised by the CI smoke job that boots the real server. Untestable code is
restructured (dependency injection of `fetch`, DNS, clocks and the vault client) until it is
testable.

## Consequences

- Tests are a design constraint, which keeps modules small and injectable.
- Every pull request either keeps 100% or explains, in the PR, why the threshold must change.
