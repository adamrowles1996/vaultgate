import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sequentialRandom } from '../test-support/identity.ts';

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normaliseRecoveryCode,
} from './recovery-codes.ts';

describe('recovery codes', () => {
  it('ID-11 issues eight distinct codes of ten base32 characters', () => {
    const codes = generateRecoveryCodes(sequentialRandom());
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(codes.every((code) => /^[A-Z2-7]{10}$/.test(code))).toBe(true);
  });

  it('ID-11 hashes the normalised code with SHA-256', () => {
    const expected = createHash('sha256').update('ABCDE23456').digest('hex');
    expect(hashRecoveryCode('abcde-23456')).toBe(expected);
    expect(normaliseRecoveryCode(' ab cde 234-56 ')).toBe('ABCDE23456');
  });
});
