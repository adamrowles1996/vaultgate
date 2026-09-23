# ADR 0007: Typed actions under operator policy, amending ADR 0004

Date: 2026-09-23. Status: accepted (planned for M9 to M15). Amends [ADR 0004](0004-no-remote-command-execution.md).

## Context

ADR 0004 refused every tool that executes a command, reads a file or fetches an arbitrary URL,
because the common shape of such a tool ("run this command with the secret substituted in")
is remote code execution behind a bearer token. That reasoning was right and the vault tools
still follow it.

Two things changed. First, the way agents are used: the operator's agents need to _use_
credentials, not read them. Today an agent that must call an API, query a database or run a
command on a server has to `get_secret` the value into its own context and run the operation
itself, which places the secret in the model's context window, the client's logs and a
command line: exactly the places vaultgate exists to keep it out of. `vault:reveal` is the
door the design wanted to keep narrow and in practice it is the door every real task walks
through. Second, the ecosystem converged on out-of-band credential use: the MCP specification
gained URL-mode elicitation so servers can hold third-party credentials the client never sees,
tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so
clients can prompt before risky calls, and form-mode elicitation so a server can obtain a
human confirmation mid-call. The vendor agent products now expose "connectors" whose
credential lives with the connector service, not the model.

## Decision

vaultgate gains an **actions layer** ([spec 13](../spec/13-actions.md),
[spec 14](../spec/14-actions-connectors.md)), off by default, in which an agent names an
operator-defined **target** and describes an operation, and vaultgate performs it with a
credential the agent never receives.

- **Targets, not tools.** The operator defines every destination, credential mapping, policy
  and grant on the account page, behind re-authentication. Agents pass no host, URL base,
  database name or credential; an argument changes what runs, never where or as whom.
- **Six typed connectors, no generic one:** `http` (with a Microsoft Graph credential adapter
  that performs the OAuth exchange server-side), `sql` (SQL Server and PostgreSQL, read and
  write as separate tools and scopes, statements classified and parameterised only), `ssh`,
  `winrm` (one command under an operator allowlist) and `browser` (a headless Chromium in a
  sidecar that vaultgate signs in, then a confined Playwright-style tool subset). A generic
  TCP or "run anything" connector is refused.
- **Five layers of consent.** A connector must be enabled in configuration; a token must hold
  the connector's scope (`actions:http`, `actions:sql.read`, `actions:sql.write`,
  `actions:ssh`, `actions:winrm`, `actions:browser`, all marked risky at consent, none implying
  another); the client must be granted the target; the target's policy must allow the
  operation; and, per target, non-read calls may require a human confirmation obtained through
  MCP form-mode elicitation. Tools carry the MCP annotations so clients can add their own
  prompt, and the server never relies on that prompt.
- **Secrets never come back.** Every injected value and its encoded variants are scrubbed
  from every result, error, snapshot, audit row and elicitation message; outputs are capped;
  nothing is logged.
- **ADR 0004 stands for the vault tools and for the host.** `ssh_run` and `winrm_run` execute on
  a remote host the operator configured, under the operator's allowlist; `browser_*` acts in a
  sidecar, on origins the operator listed. Nothing executes in the vaultgate process or on its
  host (`child_process` stays lint-confined). A target that accepts any command exists only
  behind an explicit per-target flag _and_ a deployment-level switch, and is reported to agents
  as unrestricted. The "no arbitrary command execution tool" of ADR 0004 remains true: there is
  no tool that runs an arbitrary command anywhere the agent chooses.

## Consequences

- The threat model gains attackers and threats (T24 onwards) whose common theme is a
  prompt-injected agent with a granted target; the mitigations are policy, read-only defaults,
  annotations, elicitation, allowlists, origin confinement and audit, and the residual risk that
  a granted write or browser target is what it says it is (the operator's decision) is accepted.
- Output exfiltration of query results, page content and command output is the feature; caps,
  rate limits and audit bound it rather than prevent it.
- `src/actions/` is a new dependency-cruiser layer that may use `vault`, `scopes`, `audit`,
  `storage`, `net` and `crypto` and never the identity, OAuth or MCP internals; connectors are
  separate sub-modules loaded only when enabled; new tables `action_targets`, `action_grants`,
  `action_calls` and `action_sessions`.
- New runtime dependencies are accepted per connector and justified per QG-9 (`pg`, `mssql`,
  `ssh2`, `playwright-core`; WinRM likely none); the browser itself is a sidecar image, never
  part of the core image.
- Section 01's principle 3 is restated: no arbitrary remote code execution, and no execution of
  any kind on the vaultgate host; the actions layer is the one opt-in exception and is typed.
- Milestones M9 to M15 in `PLAN.md` deliver it after v1.0.0; each ships behind
  `VAULTGATE_ENABLE_ACTIONS` with contract tests against fakes and a live test against the
  maintainer's own systems.
