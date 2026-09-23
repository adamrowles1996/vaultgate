import { describe, expect, it } from 'vitest';

import { ActionError } from '../../errors.ts';

import { channelFailure, connectFailure, messageOf } from './failures.ts';

function ssh2Error(message: string, extras: Readonly<Record<string, string>>): Error {
  return Object.assign(new Error(message), extras);
}

describe('connectFailure', () => {
  it('ACT-74 maps a refused authentication to authentication_failed with no detail to probe', () => {
    const error = connectFailure(
      ssh2Error('All configured authentication methods failed', {
        level: 'client-authentication',
      }),
    );
    expect(error.code).toBe('authentication_failed');
    expect(error.detail).toBeUndefined();
  });

  it('ACT-74 maps the library timeout to timeout', () => {
    expect(connectFailure(ssh2Error('Timed out', { level: 'client-timeout' })).code).toBe(
      'timeout',
    );
  });

  it('ACT-74 maps a socket failure to connection_failed naming the code, never the address', () => {
    const error = connectFailure(
      ssh2Error('connect ECONNREFUSED 10.0.0.1:22', {
        level: 'client-socket',
        code: 'ECONNREFUSED',
      }),
    );
    expect(error.code).toBe('connection_failed');
    expect(error.detail).toStrictEqual({ reason: 'ECONNREFUSED' });
  });

  it('ACT-74 falls back to the level when a socket failure carries no code', () => {
    expect(connectFailure(ssh2Error('broken', { level: 'client-dns' })).detail).toStrictEqual({
      reason: 'client-dns',
    });
  });

  it('ACT-74 treats a handshake the two sides could not agree as connection_failed', () => {
    const error = ssh2Error('no matching key exchange', { level: 'handshake' });
    expect(connectFailure(error)).toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'handshake' },
    });
  });

  it('ACT-74 names an error with no level, and something that is not an error at all, as unknown', () => {
    expect(connectFailure(new Error('bare')).detail).toStrictEqual({ reason: 'unknown' });
    expect(connectFailure('not an error')).toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'unknown' },
    });
  });

  it('ACT-87 passes an action error through, so the host-key mismatch stays itself', () => {
    const mismatch = new ActionError('host_key_mismatch');
    expect(connectFailure(mismatch)).toBe(mismatch);
  });
});

describe('channelFailure', () => {
  it('ACT-74 reports a channel failure after sign-in as upstream_error with the server message', () => {
    expect(channelFailure(new Error('Unable to exec'))).toMatchObject({
      code: 'upstream_error',
      detail: { message: 'Unable to exec' },
    });
  });

  it('ACT-74 passes an action error through, so a timeout stays a timeout', () => {
    const timeout = new ActionError('timeout');
    expect(channelFailure(timeout)).toBe(timeout);
  });
});

describe('messageOf', () => {
  it('ACT-74 caps a talkative server at 1 KiB and stringifies what is not an error', () => {
    const talkative = new Error('x'.repeat(2000));
    expect(messageOf(talkative)).toHaveLength(1024);
    expect(messageOf(42)).toBe('42');
  });
});
