import { describe, expect, it } from 'vitest';

import { openTestDatabase } from '../test-support/database.ts';
import { sequentialRandom } from '../test-support/identity.ts';

import { createIdentityStores } from './repositories/index.ts';
import { createSessionManager, type SessionManager } from './session-manager.ts';

const HOUR = 3_600_000;

function manager(): { sessions: SessionManager; advance: (ms: number) => void } {
  let now = 1_000_000;
  const stores = createIdentityStores(openTestDatabase());
  stores.operators.create({
    id: 'op-1',
    displayName: 'Ada',
    passwordHash: 'x',
    totpSecretCiphertext: undefined,
    totpLastStep: undefined,
    createdAt: 0,
    passwordChangedAt: 0,
  });
  return {
    sessions: createSessionManager({
      sessions: stores.sessions,
      random: sequentialRandom(),
      clock: () => now,
      absoluteTtlMs: 12 * HOUR,
    }),
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('createSessionManager', () => {
  it('ID-14 ID-16 starts a session whose id is only ever stored hashed', () => {
    const { sessions } = manager();
    const started = sessions.start('op-1', { ip: '203.0.113.7', userAgent: 'ua' });
    const [record] = sessions.list('op-1');
    expect(started.id).toHaveLength(43);
    expect(record?.idHash).toBe(started.state.idHash);
    expect(record?.idHash).not.toContain(started.id);
    expect(started.state).toStrictEqual({
      idHash: started.state.idHash,
      operatorId: 'op-1',
      csrfToken: started.state.csrfToken,
      createdAt: 1_000_000,
      expiresAt: 1_000_000 + HOUR,
      reauthenticatedAt: undefined,
      isReauthenticated: false,
    });
  });

  it('ID-14 resolves, refreshes and expires', () => {
    const { sessions, advance } = manager();
    const { id } = sessions.start('op-1', { ip: undefined, userAgent: undefined });
    advance(HOUR - 1);
    const refreshed = sessions.resolve(id);
    advance(HOUR);
    const expired = sessions.resolve(id);
    expect(refreshed?.expiresAt).toBe(1_000_000 + 2 * HOUR - 1);
    expect(expired).toBeUndefined();
    expect(sessions.resolve(id)).toBeUndefined();
    expect(sessions.resolve(undefined)).toBeUndefined();
    expect(sessions.list('op-1')).toStrictEqual([]);
  });

  it('ID-15 marks re-authentication and ends other sessions', () => {
    const { sessions, advance } = manager();
    const first = sessions.start('op-1', { ip: undefined, userAgent: undefined });
    const second = sessions.start('op-1', { ip: undefined, userAgent: undefined });
    sessions.markReauthenticated(first.state.idHash);
    advance(1);
    expect(sessions.resolve(first.id)?.isReauthenticated).toBe(true);
    expect(sessions.endOthers('op-1', first.state.idHash)).toBe(1);
    expect(sessions.resolve(second.id)).toBeUndefined();
    sessions.end(first.state.idHash);
    expect(sessions.resolve(first.id)).toBeUndefined();
  });
});
