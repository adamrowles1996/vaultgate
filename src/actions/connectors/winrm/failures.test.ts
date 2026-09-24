import { describe, expect, it } from 'vitest';

import { ActionError } from '../../errors.ts';

import {
  faultFailure,
  messageOf,
  runFailure,
  statusFailure,
  transportFailure,
  unreadableResponse,
} from './failures.ts';

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const RUNNING = new AbortController().signal;

describe('transportFailure', () => {
  it('ACT-59 answers timeout for an abort and for a signal that has already fired', () => {
    const aborted = AbortSignal.abort();
    expect(transportFailure(coded('aborted', 'ABORT_ERR'), aborted).code).toBe('timeout');
    const abortError = new DOMException('aborted', 'AbortError');
    expect(transportFailure(abortError, RUNNING).code).toBe('timeout');
  });

  it('ACT-57 answers tls_error for a certificate failure and connection_failed for the rest', () => {
    const tls = transportFailure(coded('bad certificate', 'ERR_TLS_CERT_PIN_MISMATCH'), RUNNING);
    expect(tls.code).toBe('tls_error');
    expect(tls.detail).toStrictEqual({ reason: 'ERR_TLS_CERT_PIN_MISMATCH' });
    const refused = transportFailure(coded('refused', 'ECONNREFUSED'), RUNNING);
    expect(refused.code).toBe('connection_failed');
    expect(refused.detail).toStrictEqual({ reason: 'ECONNREFUSED' });
  });

  it('ACT-74 names the error name when there is no code, and unknown when there is no error', () => {
    expect(transportFailure(new TypeError('nope'), RUNNING).detail).toStrictEqual({
      reason: 'TypeError',
    });
    expect(transportFailure('a string', RUNNING).detail).toStrictEqual({ reason: 'unknown' });
  });

  it('§13.16 passes an ActionError through untouched', () => {
    const raised = new ActionError('timeout');
    expect(transportFailure(raised, RUNNING)).toBe(raised);
  });
});

describe('faultFailure, statusFailure and unreadableResponse', () => {
  it('§13.16 turns a fault into upstream_error with its reason, capped at 1 KiB', () => {
    const long = 'x'.repeat(2000);
    expect(faultFailure({ subcode: 'ShellQuota', reason: long }).detail).toStrictEqual({
      message: 'x'.repeat(1024),
    });
  });

  it('ACT-74 never leaves the fault message empty', () => {
    expect(faultFailure({ subcode: '', reason: '' }).detail).toStrictEqual({
      message: 'the destination reported a fault',
    });
  });

  it('§13.16 answers authentication_failed for a 401 and upstream_error for any other status', () => {
    expect(statusFailure(401).code).toBe('authentication_failed');
    expect(statusFailure(401).detail).toBeUndefined();
    expect(statusFailure(500).detail).toStrictEqual({
      message: 'the destination answered HTTP 500',
    });
  });

  it('T33 says only that the response could not be read, never quoting it', () => {
    expect(unreadableResponse().detail).toStrictEqual({
      message: 'the destination sent a WS-Management response vaultgate could not read',
    });
  });
});

describe('runFailure', () => {
  it("§13.16 calls a JavaScript fault vaultgate's own, and anything else the destination's", () => {
    const internal = runFailure(new TypeError('undefined is not a function'));
    expect(internal.code).toBe('connector_fault');
    expect(internal.detail).toStrictEqual({
      reason: 'internal',
      message: 'undefined is not a function',
    });
    expect(runFailure(new Error('the host closed the shell')).code).toBe('upstream_error');
    expect(runFailure('a string').code).toBe('upstream_error');
  });

  it('§13.16 passes an ActionError through untouched', () => {
    const raised = new ActionError('tls_error');
    expect(runFailure(raised)).toBe(raised);
  });
});

describe('messageOf', () => {
  it('ACT-74 caps a message at 1 KiB and stringifies a thrown non-error', () => {
    const long = new Error('y'.repeat(2000));
    expect(messageOf(long)).toHaveLength(1024);
    expect(messageOf('plain')).toBe('plain');
  });
});
