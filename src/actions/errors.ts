/**
 * The error codes of spec §13.16 (ACT-74): every code has one fixed message,
 * `detail` is the only variable part and is scrubbed before it leaves the
 * engine, and it never carries a destination address, an origin list, a vault
 * item id or a policy pattern. Codes are stable API like tool names.
 */
export const ACTION_ERROR_MESSAGES = {
  actions_disabled: 'the actions layer is disabled on this deployment',
  connector_disabled: 'the connector behind this target is disabled on this deployment',
  unknown_target: 'no enabled, granted target of that name exists for this client',
  target_disabled: 'the target is disabled',
  target_invalid: 'the stored target fails validation; ask the operator to repair it',
  not_granted: 'this client has not been granted the target',
  insufficient_scope: 'the token does not hold the scope this tool needs',
  invalid_arguments: 'the arguments do not match the tool schema',
  policy_denied: "the target's policy does not allow this operation",
  rate_limited: 'too many calls; retry after the number of seconds in detail.retry_after_s',
  confirmation_unavailable:
    'this target requires a human confirmation and your client does not support MCP ' +
    'elicitation; ask the operator to use a client that does, or to lift the requirement for ' +
    'this target',
  confirmation_declined: 'the human declined the call',
  confirmation_cancelled: 'the human dismissed the confirmation prompt',
  confirmation_expired: 'the confirmation has expired; call again to request a new one',
  confirmation_invalid:
    'the confirmation does not verify or does not match this call; call again to request a new one',
  confirmation_reused: 'the confirmation has already been used; call again to request a new one',
  credential_unavailable:
    'the credential for this target is not available; the operator can see why on the account page',
  credential_rotation_failed: 'the rotated refresh token could not be written back to the vault',
  destination_refused:
    "the target's destination resolved to an address vaultgate refuses to connect to",
  host_key_mismatch: 'the SSH host key does not match the key pinned on the target',
  tls_error: 'the TLS certificate of the destination could not be verified',
  connection_failed: 'the destination could not be reached',
  authentication_failed: 'the destination rejected the credential',
  timeout: "the target's timeout elapsed and the operation was cancelled",
  upstream_error: 'the destination reported an error; see detail.message',
  connector_fault:
    'the call could not be completed inside vaultgate; the destination did not report this ' +
    'and may never have been contacted; see detail.reason',
  browser_unavailable: 'the browser sidecar did not answer',
  login_failed: 'the browser sign-in did not complete; see detail.stage',
  unknown_session: 'no open browser session of that id exists for this client',
  session_expired: 'the browser session has ended',
  session_limit: 'this client already holds the maximum number of open sessions on this target',
  element_not_found: 'the element reference is not in the current page',
  index_unavailable: 'the code search sidecar did not answer',
  index_not_ready:
    'the index for this repository is not ready yet; see detail.state, and retry shortly when ' +
    'it is building',
  ref_not_found: 'the repository has no branch, tag, commit or pull request of that name',
  path_not_found: 'no indexed file of that path exists in this snapshot of the repository',
  chunk_not_found: 'no indexed chunk of that file holds that line; pass a location from a search',
  not_text: 'the file is not text',
} as const satisfies Readonly<Record<string, string>>;

export type ActionErrorCode = keyof typeof ACTION_ERROR_MESSAGES;

export type ActionErrorDetail = Readonly<Record<string, string | number | boolean>>;

/**
The codes the engine refuses a call with before anything runs; every other code is a failure of the run (ACT-60).
*/
const DENIED_CODES: ReadonlySet<ActionErrorCode> = new Set<ActionErrorCode>([
  'actions_disabled',
  'connector_disabled',
  'unknown_target',
  'target_disabled',
  'target_invalid',
  'not_granted',
  'insufficient_scope',
  'invalid_arguments',
  'policy_denied',
  'rate_limited',
  'confirmation_unavailable',
  'confirmation_declined',
  'confirmation_cancelled',
  'confirmation_expired',
  'confirmation_invalid',
  'confirmation_reused',
]);

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly detail: ActionErrorDetail | undefined;

  constructor(code: ActionErrorCode, detail?: ActionErrorDetail) {
    super(ACTION_ERROR_MESSAGES[code]);
    this.name = 'ActionError';
    this.code = code;
    this.detail = detail;
  }
}

export type ActionOutcome = 'ok' | `denied:${ActionErrorCode}` | `error:${ActionErrorCode}`;

export function outcomeOf(error: ActionError): ActionOutcome {
  return DENIED_CODES.has(error.code) ? `denied:${error.code}` : `error:${error.code}`;
}
