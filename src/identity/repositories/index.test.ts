import { describe, expect, it } from 'vitest';

import { openTestDatabase } from '../../test-support/database.ts';

import { createIdentityStores } from './index.ts';

import type { OperatorRecord } from './operators.ts';
import type { SessionRecord } from './sessions.ts';

const OPERATOR: OperatorRecord = {
  id: 'op-1',
  email: 'ada@example.com',
  passwordHash: 'scrypt$16$8$1$AA==$AA==',
  totpSecretCiphertext: undefined,
  totpLastStep: undefined,
  createdAt: 1000,
  passwordChangedAt: 1000,
};

function session(idHash: string, operatorId = 'op-1'): SessionRecord {
  return {
    idHash,
    operatorId,
    createdAt: 1000,
    lastSeenAt: 1000,
    expiresAt: 5000,
    reauthenticatedAt: undefined,
    csrfToken: `csrf-${idHash}`,
    ip: undefined,
    userAgent: undefined,
  };
}

function repositories(): ReturnType<typeof createIdentityStores> {
  return createIdentityStores(openTestDatabase());
}

describe('operators repository', () => {
  it('ID-3 creates and finds the operator by id, e-mail (case-insensitively) or as the only account', () => {
    const { operators } = repositories();
    expect(operators.count()).toBe(0);
    expect(operators.findAny()).toBeUndefined();
    operators.create(OPERATOR);
    expect(operators.count()).toBe(1);
    expect(operators.findAny()).toStrictEqual(OPERATOR);
    expect(operators.findById('op-1')).toStrictEqual(OPERATOR);
    expect(operators.findByEmail('ada@example.com')).toStrictEqual(OPERATOR);
    expect(operators.findByEmail('ADA@Example.com')).toStrictEqual(OPERATOR);
    expect(operators.findById('nope')).toBeUndefined();
    expect(operators.findByEmail('nope@example.com')).toBeUndefined();
  });

  it('ID-3 ID-26 changes the e-mail, keeps it unique and tolerates a pre-migration row without one', () => {
    const { operators } = repositories();
    operators.create(OPERATOR);
    operators.updateEmail('op-1', 'grace@example.com');
    expect(operators.findById('op-1')?.email).toBe('grace@example.com');
    expect(operators.findByEmail('ada@example.com')).toBeUndefined();
    const legacy: OperatorRecord = { ...OPERATOR, id: 'op-2', email: undefined };
    operators.create(legacy);
    expect(operators.findById('op-2')).toStrictEqual(legacy);
    expect(() => {
      operators.updateEmail('op-2', 'Grace@example.com');
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('ID-6 ID-10 updates the password hash, the TOTP secret and the last accepted step', () => {
    const { operators } = repositories();
    operators.create(OPERATOR);
    operators.updatePasswordHash('op-1', 'scrypt$131072$8$1$AA==$AA==', 2000);
    operators.updateTotpSecret('op-1', 'v1.iv.ct.tag');
    operators.updateTotpLastStep('op-1', 42);
    expect(operators.findById('op-1')).toStrictEqual({
      ...OPERATOR,
      passwordHash: 'scrypt$131072$8$1$AA==$AA==',
      passwordChangedAt: 2000,
      totpSecretCiphertext: 'v1.iv.ct.tag',
      totpLastStep: 42,
    });
    operators.updateTotpSecret('op-1', 'v1.iv.ct2.tag');
    expect(operators.findById('op-1')?.totpLastStep).toBeUndefined();
  });
});

describe('recovery codes repository', () => {
  it('ID-11 replaces the set, consumes each code once and counts the rest', () => {
    const { operators, recoveryCodes } = repositories();
    operators.create(OPERATOR);
    recoveryCodes.replaceAll('op-1', ['h1', 'h2']);
    recoveryCodes.replaceAll('op-1', ['h3', 'h4', 'h5']);
    expect(recoveryCodes.countUnused('op-1')).toBe(3);
    expect(recoveryCodes.consume('op-1', 'h1', 10)).toBe(false);
    expect(recoveryCodes.consume('op-1', 'h3', 10)).toBe(true);
    expect(recoveryCodes.consume('op-1', 'h3', 11)).toBe(false);
    expect(recoveryCodes.consume('other', 'h4', 11)).toBe(false);
    expect(recoveryCodes.countUnused('op-1')).toBe(2);
  });
});

describe('bootstrap tokens repository', () => {
  it('ID-1 ID-3 honours expiry and single use', () => {
    const { bootstrapTokens } = repositories();
    bootstrapTokens.insert('t1', 1000);
    expect(bootstrapTokens.isUsable('t1', 999)).toBe(true);
    expect(bootstrapTokens.isUsable('t1', 1000)).toBe(false);
    expect(bootstrapTokens.isUsable('t2', 0)).toBe(false);
    expect(bootstrapTokens.consume('t1', 1000)).toBe(false);
    expect(bootstrapTokens.consume('t1', 500)).toBe(true);
    expect(bootstrapTokens.consume('t1', 500)).toBe(false);
    expect(bootstrapTokens.isUsable('t1', 500)).toBe(false);
  });
});

describe('sessions repository', () => {
  it('ID-14 stores, lists, touches, re-authenticates and deletes sessions', () => {
    const { operators, sessions } = repositories();
    operators.create(OPERATOR);
    const full: SessionRecord = {
      ...session('s1'),
      reauthenticatedAt: 1500,
      ip: '203.0.113.7',
      userAgent: 'Firefox',
    };
    sessions.insert(full);
    sessions.insert(session('s2'));
    expect(sessions.findByIdHash('s1')).toStrictEqual(full);
    expect(sessions.findByIdHash('s9')).toBeUndefined();
    expect(sessions.listForOperator('op-1').map((record) => record.idHash)).toStrictEqual([
      's1',
      's2',
    ]);
    sessions.touch('s2', 3000, 7000);
    sessions.setReauthenticatedAt('s2', 3100);
    expect(sessions.findByIdHash('s2')).toStrictEqual({
      ...session('s2'),
      lastSeenAt: 3000,
      expiresAt: 7000,
      reauthenticatedAt: 3100,
    });
    sessions.delete('s2');
    expect(sessions.findByIdHash('s2')).toBeUndefined();
  });

  it('ID-15 deletes every other session of the operator', () => {
    const { operators, sessions } = repositories();
    operators.create(OPERATOR);
    sessions.insert(session('s1'));
    sessions.insert(session('s2'));
    sessions.insert(session('s3'));
    expect(sessions.deleteOthersForOperator('op-1', 's2')).toBe(2);
    expect(sessions.listForOperator('op-1').map((record) => record.idHash)).toStrictEqual(['s2']);
  });
});

describe('login attempts repository', () => {
  it('ID-13 counts failures per subject within a window', () => {
    const { loginAttempts } = repositories();
    loginAttempts.record('ip:203.0.113.7', 100, false);
    loginAttempts.record('ip:203.0.113.7', 200, false);
    loginAttempts.record('ip:203.0.113.7', 300, true);
    loginAttempts.record('operator:op-1', 300, false);
    expect(loginAttempts.countFailuresSince('ip:203.0.113.7', 0)).toBe(2);
    expect(loginAttempts.countFailuresSince('ip:203.0.113.7', 150)).toBe(1);
    expect(loginAttempts.countFailuresSince('operator:op-1', 0)).toBe(1);
    expect(loginAttempts.countFailuresSince('nobody', 0)).toBe(0);
  });
});
