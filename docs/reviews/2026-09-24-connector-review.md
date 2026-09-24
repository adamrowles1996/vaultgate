# Independent review of the `ssh` and `winrm` connectors, 2026-09-24

A second reviewer, working independently of the
[actions security review](2026-09-24-actions-security-review.md) over the same tree, examined the
`ssh` and `winrm` connectors and the command policy they share. Reproduced verbatim. The two
reviewers agreed, separately, on two findings: the WinRM Basic credential is never scrubbed, and a
wildcard in a command allowlist admits shell metacharacters. The fixes landed in the releases that
follow (see the changelog).

---

Checkout on `main`. The baseline suite for the scope is green (22 files, 210 tests passed), so
everything below is a real gap rather than a broken tree.

## Findings

### 1. HIGH — the WinRM Basic credential is not scrubbed. ACT-51 violation, T34. Verified by running

`src/actions/connectors/winrm/client.ts:87-93` puts the password on the wire as
`Authorization: Basic base64(username:password)`. ACT-51 explicitly lists "the `basic` credential
`base64(username:value)`" as a required scrub variant, and `src/actions/scrub.ts:134-136` implements
it — but only `if (username !== undefined)`.

`src/actions/connectors/winrm/schemas.ts:96-98` returns a single `role: 'secret'` field and no
`role: 'username'` field, because the username lives in the _destination_ document. So
`src/actions/engine-run.ts:104-108` never assigns `username`, the secret holder is created with
`undefined`, and the Basic variant is silently dropped. `base64("user:password")` does not contain
`base64("password")` as a substring, so no other variant covers it.

Attack, per T34, a hostile or compromised Windows host: echo the received `Authorization` header
back. Both paths leak. A SOAP fault whose reason quotes the header arrives at the agent as
`upstream_error` with the header intact in `detail.message`; the same string written to standard
output arrives in `stdout`. In both cases the base64 decodes to `vaultgate:CANARY-PASSWORD-9f3c1a`.
The raw form _is_ redacted — only the form vaultgate itself created is not.

The existing canary test bakes the gap in: `src/actions/connectors/winrm/connector.test.ts:34`
asserts against a variant list that already excludes the missing variant.

Secondary: `scrub.ts:203` derives the guard band from the longest variant, 32 bytes here, while the
Basic blob is 44, so the ACT-52 capture band is undersized for it too.

Fix: feed `destination.username` to the scrubber for `winrm`, and change the canary assertion to
include the username.

### 2. HIGH (design) — a wildcard in a command pattern is an arbitrary-command wildcard, and the operator guide's own examples are exploitable. Verified by running

`src/actions/policy.ts:139-149`: for a command pattern, `*` stops only at a newline. It does not
stop at a semicolon, a pipe, an ampersand, a dollar sign, a backtick, parentheses or angle brackets,
all verified. The command reaches the login shell (`ssh/client.ts:24`) or PowerShell and the command
processor.

The only save-time guard, `policy.ts:178-191`, refuses a pattern that matches the _empty_ command,
so a bare wildcard is caught but any pattern with one literal character passes. Against the patterns
the guide itself recommends at `docs/guides/actions.md:544` and `:680`, every one of these was
accepted at save and allowed at call time: a command substitution inside the wildcard, a semicolon
followed by a pipeline to a shell, a backtick substitution, an `&&` chain into `sudo`, a PowerShell
`iex` of a downloaded string, and a pipeline into `Remove-Item -Recurse -Force`. Only a command
matching nothing in the pattern, such as `rm -rf /`, was denied.

So any `allowed_commands` target with a wildcard anywhere is, in practice, `any_command: true` —
without the deployment consent, without the standing operator warning, without `unrestricted: true`
in `actions_list_targets`, and without the full command written to `classification` per ACT-88. That
is the whole of T24's command-allowlist mitigation, bypassed by punctuation.

The implementation matches ACT-34 exactly; the gap is that the command side has no counterpart to
the SQL side's tokeniser, and nothing in the guide warns about shell metacharacters — its only
warning is about a bare wildcard. Minimum fix: a save-time refusal or warning when a wildcard
pattern can span a shell metacharacter, plus guide text. Better: tokenise the command on
non-`any_command` targets and refuse metacharacters outside quotes.

### 3. MEDIUM — ACT-34's claim that an operator cannot write a super-linear pattern is false; there is no cap on pattern length or count. Verified by running

`src/actions/policy.ts:159-170` is linear in tokens times subject length with no backtracking, so
there is no classical catastrophic backtracking — but the effect is reachable.
`src/actions/connectors/command.ts:104` has no maximum on either the string or the array, and the
policy document is typed loosely at the repository boundary. Against a 16 KiB command, the ACT-27
ceiling: a pattern of 1000 repetitions took 661 ms, 10 000 took 6.5 seconds, and 50 000 took 29
seconds, each blocking the single-threaded event loop.

`authorize` runs inside `resolveCall`, which the engine calls **before** acquiring the rate limiter,
so the limiter does not gate it. Operator-authored rather than agent-authored, hence medium, but the
spec claims this is impossible. Cap the pattern length and the list length.

### 4. MEDIUM — the WinRM `Receive` poll loop has no interval, no backoff and no cap. Verified against a real loopback socket

`src/actions/connectors/winrm/client.ts:205-219` loops without delay. A destination that answers
`Receive` with an immediate `TimedOut` fault, which the specification says means "ask again", drives
the loop at full speed for the entire policy timeout: 1756 requests in 1006 ms, about 1746 per
second. With the timeout at its 300-second ceiling that is roughly half a million outbound requests
and 300 seconds of near-total processor use from a single tool call. The per-target rate limit
counts calls, not polls. This is availability and outbound amplification, not compromise, and
ACT-90 does not mandate a minimum interval either, so it is a specification gap as well.

Honest correction: with the in-process fake transport I first measured total microtask starvation,
which would have meant the policy timeout could never fire. That turned out to be an artefact of a
fake that resolves without input or output. Over a real socket the timer fired at exactly 1000 ms
and a parallel interval ticked every time. **The timeout mechanism is sound**; only the unbounded
poll rate is real.

### 5. LOW — a carriage return in a `cmd` command is sent raw and silently becomes a line feed at the host. Verified

`src/actions/connectors/winrm/envelopes.ts:57-64` escapes the five reserved characters but does not
encode a carriage return, and `:133` places the command as raw text content. XML line-end
normalisation makes the remote parser turn it into a line feed. Only reachable on `any_command`
targets, since a carriage return is otherwise refused, and the PowerShell path is unaffected because
it is base64. A fidelity bug, not a bypass.

### 6. LOW — PowerShell encoded commands overflow the Windows command line well below ACT-27's ceiling. Verified

A 16 KiB ASCII command becomes 32 KiB of UTF-16LE and then 43 692 base64 characters, against
Windows' 32 767-character limit. Commands above roughly 12 KiB will fail at the host with an opaque
error despite passing every vaultgate check.

### 7. LOW — a 512 KiB response cap against a 1 MiB output cap means an over-large single answer fails the call rather than truncating. Verified

`client.ts:56` fixes the response cap while the policy allows up to 1 MiB of output, and base64
inflates by a third. A single `Receive` carrying 200 KB on each stream is cut mid-document and the
whole call returns an upstream error. Fail-closed and documented as intentional, but the operator
gets no signal that the host is ignoring the envelope size.

### 8. LOW — the XML element attribute map is typed as a plain record but built from an object literal. Verified

`xml.ts:109` and `:124` assign into `{}`, and the name pattern admits `__proto__`. Verified: **no
prototype pollution**, because assigning a string through the setter is a no-op, but the attribute
is silently dropped and inherited members are reachable through the map. No current reader is
exploitable, but the type is a lie. Use a null-prototype object and an own-property check.

### 9. LOW — response readers are position-insensitive, and the fault reader is position-over-sensitive. Verified

`responses.ts:51` and `:110` accept their elements anywhere in the document, including inside the
header, so a shell identifier buried in the header was accepted and a command state in the header
ended the poll loop with a zero exit code. Conversely the fault reader reads only the first body
child, so a fault in a second body returned with a 200 status is missed entirely. Neither crosses a
trust boundary, since the host already authors its own output, but both should be anchored.

### 10. INFORMATIONAL — the host verifier has no exception guard

`ssh/driver.ts:95-101`. I traced the library: a throw propagates out of the protocol data handler
rather than falling through to "accepted". It fails closed, and is not currently reachable, but a
defensive wrapper is worth having.

### 11. INFORMATIONAL — a contract-test blind spot on exactly the injection-relevant inputs. Verified

The strict reader refuses an escaped ampersand, so the fake destination throws on any command
envelope whose command contains a reserved character. No contract test can drive a command
containing XML metacharacters through the fake.

## Categories that are clean

- **ACT-27 enforcement and ordering.** Schema validation runs before the connector's authorize.
  Verified refusals: NUL, bell, escape, an escape sequence, and over 16 KiB measured in _bytes_.
  Tab, line feed and carriage return are accepted at schema level, then denied before the allowlist
  match on a non-`any_command` target, so **there is no second-line smuggling**.
- **No regular expression is built from operator input.** Every metacharacter is literal, matching is
  anchored at both ends and case-sensitive.
- **`any_command` call-time gating — fully correct, both connectors.** With a row saved while the
  switch was on and the connector rebuilt with it off: the call is denied, the target is not listed,
  and the stored row still validates so the operator page can repair it. Saving a new any-command
  target with the switch off is refused at save.
- **SSH host-key pinning.** Both pin forms parse; mismatches, truncations and empty values fail
  closed; the comparison is over public host-key material, so there is no secret to time. The
  verifier runs in the key-exchange reply handler and user authentication is only requested after it
  passes, so **no credential is offered before the check**. The authentication handler iterates a
  single fixed method, so there is no anonymous, agent or keyboard-interactive fallback.
- **WinRM XML hardening.** Document type declarations, external entities, internal entities,
  predefined entities, comments, character data sections, processing instructions, multiple roots,
  trailing junk, unclosed elements and mismatched tags are all refused. Depth, element and attribute
  caps are enforced exactly, a 100 000-deep input is refused in under a millisecond with no stack
  overflow, and no quadratic blow-up was found across several 500 KiB adversarial inputs. No
  uncaught exception escapes: protocol problems become an upstream error with a fixed message,
  JavaScript faults become a connector fault, and the engine has a final net.
- **Command construction.** All five reserved characters are escaped everywhere, the sequence that
  would close a character data section is neutralised, the encoding round-trips exactly, and the
  shell-skip flag is correct per ACT-28. Host-supplied identifiers are escaped before re-entering an
  envelope.
- **SSH credential leakage.** Failure details are built from the library's level and code only,
  never a message or an address. End to end with 500 KB of standard error containing a canary
  private key, neither the key nor the password leaked.
- **Output caps and timeouts.** Both streams are capped independently and the capture stops
  allocating once full, so a flooding host cannot grow the heap. On timeout the WinRM client signals
  and then deletes the shell, each with its own deadline; SSH kills the channel and ends the
  connection in a finally block.

## Suggested priority

1. Finding 1, scrubbing the Basic variant and fixing the canary test: a one-line class of fix, and a
   stated specification requirement currently violated.
2. Finding 2, command-pattern metacharacters: the largest gap between what the allowlist promises an
   operator and what it delivers. Needs a decision, and at minimum explicit guide text plus fixing
   the guide's own exploitable examples.
3. Findings 3 and 4, bounded-input hygiene: cap the pattern length, add a poll floor.
