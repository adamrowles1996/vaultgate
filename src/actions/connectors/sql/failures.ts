/**
 * What a driver's failure means (§13.16, ACT-74): the codes a driver hangs
 * on its error and on the error it wraps, mapped to one action error code
 * per engine. Anything the map does not know is `upstream_error` with the
 * driver's own message, scrubbed by the engine and capped at 1 KiB; the
 * detail never carries an address, only the driver's code.
 */
import { isTlsErrorCode } from '../../../net/tls-error.ts';
import { ActionError } from '../../errors.ts';

import type { ActionErrorCode } from '../../errors.ts';

const MESSAGE_CAP = 1024;
const MAX_WRAPPING = 4;

export interface DriverFault {
  /**
  The `code` of the error and of every error it wraps, outermost first.
  */
  readonly codes: readonly string[];
  /**
  The error's own constructor name, or the empty string when the throw was not an `Error` at all.
  */
  readonly name: string;
  readonly message: string;
}

function propertyOf(error: Error, name: 'code' | 'originalError'): unknown {
  return Object.getOwnPropertyDescriptor(error, name)?.value;
}

function codeOf(error: Error): string | undefined {
  const code = propertyOf(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function wrappedBy(error: Error): unknown {
  return error.cause ?? propertyOf(error, 'originalError');
}

/**
Every code a driver error carries, following `cause` and `mssql`'s `originalError`.
*/
export function faultOf(error: unknown): DriverFault {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_WRAPPING && current instanceof Error; depth += 1) {
    const code = codeOf(current);
    if (code !== undefined) {
      codes.push(code);
    }
    current = wrappedBy(current);
  }
  return error instanceof Error
    ? { codes, name: error.name, message: error.message }
    : { codes, name: '', message: String(error) };
}

export type FaultCodes = Readonly<Record<string, ActionErrorCode>>;

/**
 * An `ActionError` has already been classified — the session raises one of
 * its own when a value cannot be rendered faithfully — and passes through
 * unchanged; nothing about it is the driver's to reinterpret.
 * A certificate failure anywhere in the chain is `tls_error` (ACT-57), even
 * when the driver wraps it in a socket error of its own; otherwise the
 * outermost code the table knows wins, so a `mssql` `ESOCKET` around an
 * `ECONNREFUSED` still answers `connection_failed`. A code the table does
 * not know is `upstream_error` with the driver's own message.
 */
export function actionErrorOf(error: unknown, table: FaultCodes): ActionError {
  if (error instanceof ActionError) {
    return error;
  }
  const fault = faultOf(error);
  const tls = fault.codes.find((code) => isTlsErrorCode(code));
  if (tls !== undefined) {
    return new ActionError('tls_error', { reason: tls });
  }
  for (const code of fault.codes) {
    const mapped = table[code];
    if (mapped !== undefined) {
      return new ActionError(mapped, { reason: code });
    }
  }
  return new ActionError('upstream_error', { message: fault.message.slice(0, MESSAGE_CAP) });
}
