# Contributing

Thank you for looking. This project holds itself to a deliberately high bar;
the rules below are enforced by tooling, not by hoping.

## Workflow

1. Open an issue or pick one. For anything beyond a small fix, agree the
   approach first; the specification (`docs/spec/`) is normative and a change
   that contradicts it must change the spec in the same pull request.
2. Branch from `main`. One logical change per pull request.
3. Run `npm run quality` locally. It is exactly what CI runs.
4. Title the pull request as a Conventional Commit subject:
   `feat(oauth): rotate refresh tokens per family`. Squash merges use it as the
   commit subject.
5. Fill in the pull request template. Reviews are about correctness, security
   and the specification, in that order.

## What the repository enforces

| Rule                                              | Why                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| 100% test coverage, no ignore hints               | The untested branch is always the error path in the token endpoint.        |
| Files ≤ 300 lines, functions ≤ 60 lines           | Small units are reviewable; security code must be readable in one sitting. |
| Cyclomatic complexity ≤ 10, cognitive ≤ 15        | Same reason.                                                               |
| `process.env` only in `src/config.ts`             | One validated configuration object; no hidden knobs.                       |
| `child_process` only in the `bw serve` supervisor | There is no legitimate second place to spawn a process in this server.     |
| No `console`                                      | Structured logs with redaction, always.                                    |
| No `any`, no non-null assertions                  | The compiler is a reviewer.                                                |
| Exact dependency versions; justified additions    | Supply chain is part of the attack surface.                                |
| GitHub Actions pinned to commit SHAs              | Tags move.                                                                 |
| Conventional Commit subjects                      | The changelog and release notes are generated from history.                |

## Tests

- Unit and integration tests live next to the code as `*.test.ts` and run with vitest.
- Tests never use the network or the wall clock; inject `fetch`, DNS and clocks.
- Name tests after the requirement they prove where one exists:
  `it('OAUTH-23 rejects a PKCE verifier that does not match', …)`.
- A bug fix includes a test that fails before the fix.

## Dependencies

The default answer to a new dependency is no. If you must add one, the pull
request explains: what it does, why `node:*` or something in-tree does not
suffice, installed size, transitive count, last release date, and the
alternatives. Native addons are not accepted.

## Security

Never open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under Apache-2.0.
