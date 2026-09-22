# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project scaffold: TypeScript on Node 26, strict lint and type gates, 100% coverage gate,
  file-size and commit-subject gates, pinned CI with CodeQL, Scorecard and Dependabot.
- Repository-wide gates: actionlint, shellcheck and shfmt, markdownlint, cspell (en-GB),
  eslint-plugin-regexp, eslint-plugin-n, eslint-plugin-unicorn, @vitest/eslint-plugin,
  dependency-cruiser layering rules, lockfile-lint, sort-package-json, editorconfig-checker,
  gitleaks and `npm audit signatures`, with non-npm tools pinned in `.mise.toml`.
- Minimal server with validated configuration, redacting logger and health probes.
- Full configuration schema (spec §08): every variable validated in one pass, `_FILE` variants
  for secrets with permission warnings, duration and URL rules, and a masked start-up summary.
- Specification (`docs/spec/`), delivery plan, threat model and initial ADRs.

[Unreleased]: https://github.com/adamrowles1996/vaultgate/commits/main
