import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Every credential vaultgate mints carries a recognisable prefix so leak
 * scanners (including the repository's own gitleaks rule) can find it, and a
 * body of 32 random bytes encoded as base64url (43 characters).
 */
export const CREDENTIAL_PREFIX = {
  authorizationCode: 'vg_ac_',
  accessToken: 'vg_at_',
  refreshToken: 'vg_rt_',
  clientId: 'vg_c_',
} as const;

export type CredentialPrefix = (typeof CREDENTIAL_PREFIX)[keyof typeof CREDENTIAL_PREFIX];

export const CREDENTIAL_RANDOM_BYTES = 32;

/**
 * How much of a credential may be written to an audit row: the prefix plus
 * the first eight characters of the body, enough to correlate, useless to replay.
 */
const AUDIT_PREFIX_BODY_CHARACTERS = 8;

/**
 * Source of randomness; injected so tests are deterministic (QG-2).
 */
export type RandomSource = (bytes: number) => Buffer;

export function mintCredential(prefix: CredentialPrefix, random: RandomSource): string {
  return `${prefix}${random(CREDENTIAL_RANDOM_BYTES).toString('base64url')}`;
}

/**
 * The only form of a credential that reaches the store (STORE-4).
 */
export function hashCredential(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hasCredentialPrefix(value: string, prefix: CredentialPrefix): boolean {
  return value.startsWith(prefix) && value.length > prefix.length;
}

export function auditPrefix(value: string): string {
  const bodyStart = value.indexOf('_', 'vg_'.length) + 1;
  return value.slice(0, bodyStart + AUDIT_PREFIX_BODY_CHARACTERS);
}

/**
 * Length-independent equality for secrets (OAUTH-23). Different lengths are
 * compared against themselves so the timing does not reveal the length either.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}
