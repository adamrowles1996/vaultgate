# 11 Quality gates

Every gate below runs on every pull request and on `main`. A gate that
cannot be satisfied is fixed in the code, not relaxed in the configuration;
loosening a gate is a separate pull request with its own justification.

## 11.1 Static gates

| Gate            | Tool                                                                                                                                                              | Threshold                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Formatting      | Prettier                                                                                                                                                          | `--check` clean                                                                        |
| Lint            | ESLint 10, typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`, import-x, sonarjs, unused-imports, eslint-comments                                     | zero errors, zero warnings, no unused or undescribed disable directives                |
| Types           | `tsc` with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `erasableSyntaxOnly`, `verbatimModuleSyntax` | clean                                                                                  |
| Dead code       | knip                                                                                                                                                              | no unused files, exports, types or dependencies                                        |
| File size       | `scripts/check-file-sizes.mjs`                                                                                                                                    | ≤ 64 KiB per tracked file; ≤ 300 lines for code and config; ≤ 1 200 lines for Markdown |
| Function size   | ESLint `max-lines-per-function`, `complexity`, `max-params`, `max-depth`, `sonarjs/cognitive-complexity`                                                          | 60 lines, complexity 10, 4 params, depth 3, cognitive 15                               |
| Boundaries      | ESLint restricted syntax and imports                                                                                                                              | ARCH-1, ARCH-2, ARCH-3, ARCH-7                                                         |
| Commit subjects | `scripts/check-commit-message.mjs` (hook and PR title)                                                                                                            | Conventional Commits, ≤ 100 chars                                                      |

## 11.2 Test gates

| Gate               | Tool                                                                        | Threshold                                                                                                   |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unit + integration | vitest                                                                      | 100% statements, branches, functions and lines over `src/**` (entrypoint excluded, covered by smoke)        |
| Boot smoke         | `scripts/smoke-test.sh`                                                     | compiled build and type-stripped source both answer `/healthz`                                              |
| OAuth conformance  | contract tests driving the real app with the MCP client SDK's OAuth helpers | full CIMD, DCR and pre-registered handshakes succeed; every negative case in 03 returns the specified error |
| Secret containment | canary tests                                                                | no canary string from a fixture vault appears in any non-`get_secret` result or any log line                |
| RFC vectors        | unit                                                                        | TOTP (RFC 6238 Appendix B), PKCE (RFC 7636 Appendix B), scrypt known-answer                                 |

- **QG-1** Coverage ignore hints (`/* v8 ignore … */`) are forbidden. A branch that cannot be
  exercised is either removed or restructured until it can.
- **QG-2** Tests never sleep on wall-clock time; timers are faked. Tests never touch the network;
  the CIMD fetcher takes an injected `fetch` and DNS resolver.
- **QG-3** Every bug fix adds a test that fails before the fix.

## 11.3 Supply chain

- **QG-4** Exact dependency versions (`save-exact`), committed lockfile, `npm ci` everywhere.
- **QG-5** GitHub Actions pinned to full commit SHAs with a version comment; Dependabot keeps
  them current weekly.
- **QG-6** `step-security/harden-runner` on every job; workflow `permissions` start at
  `contents: read`.
- **QG-7** Dependency review on pull requests fails on any known vulnerability and on
  GPL/AGPL/LGPL-3.0 licences (incompatible with Apache-2.0 redistribution in this project).
- **QG-8** CodeQL (`security-extended`) and OpenSSF Scorecard run weekly and on `main`.
- **QG-9** New runtime dependencies are justified in the PR (purpose, why nothing in-tree or in
  Node suffices, install size, transitive count, maintenance status). Native addons are not
  accepted; `node:sqlite` and `node:crypto` are why.

## 11.4 Release

- **QG-10** A release is a signed tag `vX.Y.Z` on `main` created by the release workflow from a
  `chore(release): vX.Y.Z` commit that updates `CHANGELOG.md` and `package.json`. The workflow
  builds the multi-arch image, signs it, attaches SBOM and provenance, and publishes a GitHub
  release with the changelog section as notes.
- **QG-11** `main` is protected: pull requests only, required checks (`quality`, `test`,
  `build-and-smoke`, `pr-title`, `dependency-review`, CodeQL), linear history, conversation
  resolution, no force pushes, administrators included.
