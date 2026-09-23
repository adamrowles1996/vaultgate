# ADR 0004: No tool executes commands, reads files or fetches arbitrary URLs

Date: 2026-09-22. Status: accepted; amended by [ADR 0007](0007-typed-actions-with-operator-policy.md)
on 2026-09-23 (the planned, opt-in actions layer is the one typed exception; the vault tools and
the vaultgate host are unchanged).

## Context

Local credential MCP servers often provide an "inject secret into command" tool: run a command
with a placeholder replaced by the secret, so the model never sees the value. Over HTTPS, to a
remote server, that is remote code execution behind a bearer token.

## Decision

vaultgate exposes vault operations only. There is no command execution, no file access, no
arbitrary HTTP fetch, no expression evaluation. The only network fetch the server performs on an
agent's behalf is the CIMD document fetch, through an SSRF guard. `child_process` is importable
only from the `bw serve` supervisor, enforced by lint.

## Consequences

- An agent that wants to use a secret in a command must reveal it (with `vault:reveal`) and run
  the command itself; the reveal is audited.
- Features that would need code execution (e.g. SSH key deployment) are out of scope by design.
- Amended by ADR 0007: the actions layer (spec 13, 14) lets an agent use a credential against an
  operator-defined target under policy, without receiving it. It adds no command execution on
  the vaultgate host and no arbitrary tool; the reasoning above still governs the vault tools.
