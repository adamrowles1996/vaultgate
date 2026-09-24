/**
 * What a WinRM failure means (§13.16, ACT-74). A transport failure is the
 * policy timeout when the call was cancelled, `tls_error` when the
 * certificate did not verify or did not match the pin (ACT-57), and
 * `connection_failed` otherwise, naming the error code and never an address.
 * A `401` is the destination rejecting the credential; a SOAP fault is the
 * destination speaking after authentication, so it is `upstream_error` with
 * its own reason, capped here and scrubbed by the engine.
 */
import { isTlsErrorCode } from '../../../net/tls-error.ts';
import { ActionError } from '../../errors.ts';

import type { SoapFault } from './responses.ts';

const MESSAGE_CAP = 1024;

export const UNAUTHORIZED = 401;
export const OK = 200;

function codeOf(error: unknown): string {
  if (error instanceof Error) {
    return 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  }
  return 'unknown';
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MESSAGE_CAP);
}

/**
ACT-59: an abort is the policy timeout; ACT-57: a certificate problem is `tls_error`.
*/
export function transportFailure(error: unknown, signal: AbortSignal): ActionError {
  if (error instanceof ActionError) {
    return error;
  }
  const code = codeOf(error);
  if (code === 'AbortError' || signal.aborted) {
    return new ActionError('timeout');
  }
  return new ActionError(isTlsErrorCode(code) ? 'tls_error' : 'connection_failed', {
    reason: code,
  });
}

/**
 * A fault the shell reported: its reason, capped, with the subcode when the
 * destination gave no reason at all, so `detail.message` is never empty.
 */
export function faultFailure(fault: SoapFault): ActionError {
  const message = fault.reason === '' ? fault.subcode : fault.reason;
  return new ActionError('upstream_error', {
    message: (message === '' ? 'the destination reported a fault' : message).slice(0, MESSAGE_CAP),
  });
}

/**
A response vaultgate could not read at all: never the destination's own words, so nothing to scrub.
*/
export function unreadableResponse(): ActionError {
  return new ActionError('upstream_error', {
    message: 'the destination sent a WS-Management response vaultgate could not read',
  });
}

/**
The JavaScript faults; a Windows host reports none of these, so one of them is vaultgate's own bug.
*/
const INTERNAL_FAULTS: ReadonlySet<string> = new Set([
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
]);

/**
 * §13.16: a failure the session did not classify reaches here unclassified. A
 * JavaScript fault is vaultgate's own — answering `upstream_error` would tell
 * the agent that a destination reported something, when the destination may
 * never have been contacted — so it is `connector_fault`. Anything else is
 * the host's answer after sign-in.
 */
export function runFailure(error: unknown): ActionError {
  if (error instanceof ActionError) {
    return error;
  }
  const message = messageOf(error);
  const name = error instanceof Error ? error.name : 'unknown';
  return INTERNAL_FAULTS.has(name)
    ? new ActionError('connector_fault', { reason: 'internal', message })
    : new ActionError('upstream_error', { message });
}

export function statusFailure(status: number): ActionError {
  return status === UNAUTHORIZED
    ? new ActionError('authentication_failed')
    : new ActionError('upstream_error', { message: `the destination answered HTTP ${status}` });
}
