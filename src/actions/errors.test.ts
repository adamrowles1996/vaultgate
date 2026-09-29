import { describe, expect, it } from 'vitest';

import { ACTION_ERROR_MESSAGES, ActionError, outcomeOf } from './errors.ts';

/**
Every code of spec §13.16 plus `insufficient_scope` (ACT-16).
*/
const CODES = [
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
  'credential_unavailable',
  'credential_rotation_failed',
  'destination_refused',
  'host_key_mismatch',
  'tls_error',
  'connection_failed',
  'authentication_failed',
  'timeout',
  'upstream_error',
  'connector_fault',
  'browser_unavailable',
  'login_failed',
  'unknown_session',
  'session_expired',
  'session_limit',
  'element_not_found',
  'index_unavailable',
  'index_not_ready',
  'ref_not_found',
  'path_not_found',
  'chunk_not_found',
  'not_text',
];

const byName = (left: string, right: string): number => left.localeCompare(right);

describe('ActionError', () => {
  it('ACT-74 has one fixed message per code of §13.16 and carries detail as the only variable part', () => {
    expect(Object.keys(ACTION_ERROR_MESSAGES).toSorted(byName)).toStrictEqual(
      CODES.toSorted(byName),
    );
    expect(new Set(Object.values(ACTION_ERROR_MESSAGES)).size).toBe(CODES.length);
    const error = new ActionError('policy_denied', { reason: 'path' });
    expect(error).toMatchObject({
      name: 'ActionError',
      code: 'policy_denied',
      message: "the target's policy does not allow this operation",
      detail: { reason: 'path' },
    });
    expect(new ActionError('timeout').detail).toBeUndefined();
  });

  it('ACT-60 classes a refusal before the run as denied and everything after it as error', () => {
    expect(outcomeOf(new ActionError('not_granted'))).toBe('denied:not_granted');
    expect(outcomeOf(new ActionError('rate_limited'))).toBe('denied:rate_limited');
    expect(outcomeOf(new ActionError('policy_denied'))).toBe('denied:policy_denied');
    expect(outcomeOf(new ActionError('credential_unavailable'))).toBe(
      'error:credential_unavailable',
    );
    expect(outcomeOf(new ActionError('timeout'))).toBe('error:timeout');
  });
});
