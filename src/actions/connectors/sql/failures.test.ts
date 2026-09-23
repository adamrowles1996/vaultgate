import { describe, expect, it } from 'vitest';

import { ActionError } from '../../errors.ts';

import { actionErrorOf, faultOf } from './failures.ts';

function coded(message: string, code: string, wrapped?: Error): Error {
  return Object.assign(new Error(message, wrapped === undefined ? {} : { cause: wrapped }), {
    code,
  });
}

const TABLE = { ECONNREFUSED: 'connection_failed', ELOGIN: 'authentication_failed' } as const;

describe('driver faults', () => {
  it('ACT-74 reads the code of an error and of every error it wraps', () => {
    const fault = faultOf(coded('outer', 'ESOCKET', coded('inner', 'ECONNREFUSED')));
    expect(fault).toStrictEqual({
      codes: ['ESOCKET', 'ECONNREFUSED'],
      name: 'Error',
      message: 'outer',
    });
  });

  it("ACT-74 follows mssql's originalError as well as cause", () => {
    const inner = coded('inner', 'ECONNREFUSED');
    const outer = Object.assign(new Error('outer'), { code: 'ESOCKET', originalError: inner });
    expect(faultOf(outer).codes).toStrictEqual(['ESOCKET', 'ECONNREFUSED']);
  });

  it('ACT-74 an error with no code and a value that is not an error still yield a message', () => {
    expect(faultOf(new Error('plain'))).toStrictEqual({
      codes: [],
      name: 'Error',
      message: 'plain',
    });
    expect(faultOf('not an error')).toStrictEqual({
      codes: [],
      name: '',
      message: 'not an error',
    });
  });

  it('ACT-74 stops following a chain that wraps itself', () => {
    const looping: Error & { cause?: unknown } = coded('loop', 'ELOOP');
    looping.cause = looping;
    expect(faultOf(looping).codes).toStrictEqual(['ELOOP', 'ELOOP', 'ELOOP', 'ELOOP']);
  });
});

describe('mapping a driver fault to an action error', () => {
  it('ACT-57 a certificate failure anywhere in the chain is tls_error', () => {
    const error = actionErrorOf(
      coded('socket', 'ESOCKET', coded('cert', 'CERT_HAS_EXPIRED')),
      TABLE,
    );
    expect(error.code).toBe('tls_error');
    expect(error.detail).toStrictEqual({ reason: 'CERT_HAS_EXPIRED' });
  });

  it('ACT-74 otherwise the outermost code the table knows wins', () => {
    const error = actionErrorOf(
      coded('socket', 'EUNKNOWN', coded('refused', 'ECONNREFUSED')),
      TABLE,
    );
    expect(error.code).toBe('connection_failed');
    expect(error.detail).toStrictEqual({ reason: 'ECONNREFUSED' });
  });

  it('ACT-74 an error the session has already classified passes through untouched', () => {
    const already = new ActionError('connector_fault', { reason: 'exact_numeric_precision' });
    expect(actionErrorOf(already, TABLE)).toBe(already);
  });

  it('ACT-74 an unknown code is upstream_error with the driver message, capped at 1 KiB', () => {
    const error = actionErrorOf(coded('x'.repeat(2000), 'EREQUEST'), TABLE);
    expect(error.code).toBe('upstream_error');
    expect(error.detail).toStrictEqual({ message: 'x'.repeat(1024) });
  });
});
