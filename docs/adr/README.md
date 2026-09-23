# Architecture decision records

Short, dated records of decisions that would be expensive to reverse. New
records get the next number; superseded records are kept and marked.

| ADR                                                | Decision                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [0001](0001-typescript-on-node-26.md)              | TypeScript on Node 26 with native type stripping and `node:sqlite`                            |
| [0002](0002-own-authorization-server.md)           | vaultgate is its own OAuth 2.1 authorization server                                           |
| [0003](0003-bw-serve-backend.md)                   | The vault is reached through a managed loopback `bw serve`                                    |
| [0004](0004-no-remote-command-execution.md)        | No tool executes commands, reads files or fetches arbitrary URLs (amended by 0007)            |
| [0005](0005-built-in-operator-login.md)            | Built-in operator account (password + TOTP) before passkeys/OIDC                              |
| [0006](0006-one-hundred-percent-coverage.md)       | 100% coverage with no ignore hints                                                            |
| [0007](0007-typed-actions-with-operator-policy.md) | Typed actions under operator policy: targets, scopes, annotations, elicitation (planned, M9+) |
