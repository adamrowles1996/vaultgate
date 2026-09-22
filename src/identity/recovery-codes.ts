import { createHash } from 'node:crypto';

import { randomBase32 } from './base32.ts';

import type { RandomSource } from './primitives.ts';

const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_LENGTH = 10;

/**
Eight codes of ten base32 characters (ID-11), shown to the operator once.
*/
export function generateRecoveryCodes(random: RandomSource): readonly string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBase32(random(RECOVERY_CODE_LENGTH)),
  );
}

/**
Normalises what a person types (case, spaces, dashes) before hashing.
*/
export function normaliseRecoveryCode(text: string): string {
  return text.toUpperCase().replaceAll(/[\s-]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}
