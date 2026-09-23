/**
 * What an `ssh2` failure means (§13.16, ACT-74): the library hangs a `level`
 * on every error it emits and, for a socket failure, the system's `code` as
 * well. Anything the table does not know is `connection_failed` naming the
 * level, and a failure of the exec channel after sign-in is `upstream_error`
 * with the library's own message, scrubbed by the engine and capped at 1 KiB.
 * The detail never carries an address, only the level or code.
 */
import { ActionError } from '../../errors.ts';

import type { ActionErrorCode } from '../../errors.ts';

const MESSAGE_CAP = 1024;

/**
 * `client-authentication` is the server refusing every method the target
 * offered; `client-timeout` is the library's own readiness or keepalive
 * deadline, which is `timeout` like the engine's; `client-socket` and
 * `client-dns` are the network. A `handshake` or `protocol` level is a
 * server vaultgate could not agree terms with: it never reached
 * authentication, so it is a failure to connect.
 */
const LEVELS: Readonly<Record<string, ActionErrorCode>> = {
  agent: 'authentication_failed',
  'client-authentication': 'authentication_failed',
  'client-dns': 'connection_failed',
  'client-socket': 'connection_failed',
  'client-timeout': 'timeout',
};

function propertyOf(error: Error, name: 'level' | 'code'): string | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(error, name)?.value;
  return typeof value === 'string' ? value : undefined;
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MESSAGE_CAP);
}

/**
 * A failure while opening the connection. An `ActionError` passes through:
 * the host-key check raises `host_key_mismatch` itself (ACT-87), and the
 * abort raises `timeout`.
 */
export function connectFailure(error: unknown): ActionError {
  if (error instanceof ActionError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return new ActionError('connection_failed', { reason: 'unknown' });
  }
  const level = propertyOf(error, 'level') ?? 'unknown';
  const mapped = LEVELS[level];
  if (mapped === undefined) {
    return new ActionError('connection_failed', { reason: level });
  }
  return mapped === 'connection_failed'
    ? new ActionError(mapped, { reason: propertyOf(error, 'code') ?? level })
    : new ActionError(mapped);
}

/**
A channel that could not be opened or that failed mid-command, after sign-in: the server's own words.
*/
export function channelFailure(error: unknown): ActionError {
  return error instanceof ActionError
    ? error
    : new ActionError('upstream_error', { message: messageOf(error) });
}
