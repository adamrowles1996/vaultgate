import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  auditPrefix,
  CREDENTIAL_PREFIX,
  CREDENTIAL_RANDOM_BYTES,
  hasCredentialPrefix,
  hashCredential,
  isConstantTimeEqual,
  mintCredential,
} from './credentials.ts';

const fixedRandom = (bytes: number): Buffer => Buffer.alloc(bytes, 7);

describe('mintCredential', () => {
  it('OAUTH-24 mints prefix plus 32 random bytes as base64url (43 characters)', () => {
    const token = mintCredential(CREDENTIAL_PREFIX.accessToken, fixedRandom);
    expect(token.startsWith('vg_at_')).toBe(true);
    expect(token.slice('vg_at_'.length)).toHaveLength(43);
    expect(token).toMatch(/^vg_at_[\w-]{43}$/);
    expect(CREDENTIAL_RANDOM_BYTES).toBe(32);
  });

  it('OAUTH-19 mints authorization codes with the vg_ac_ prefix', () => {
    expect(mintCredential(CREDENTIAL_PREFIX.authorizationCode, fixedRandom)).toMatch(/^vg_ac_/);
  });
});

describe('hashCredential', () => {
  it('STORE-4 is the hex SHA-256 of the credential', () => {
    const token = mintCredential(CREDENTIAL_PREFIX.refreshToken, fixedRandom);
    expect(hashCredential(token)).toBe(createHash('sha256').update(token).digest('hex'));
  });
});

describe('hasCredentialPrefix', () => {
  it('requires the prefix and a non-empty body', () => {
    expect(hasCredentialPrefix('vg_at_abc', CREDENTIAL_PREFIX.accessToken)).toBe(true);
    expect(hasCredentialPrefix('vg_at_', CREDENTIAL_PREFIX.accessToken)).toBe(false);
    expect(hasCredentialPrefix('vg_rt_abc', CREDENTIAL_PREFIX.accessToken)).toBe(false);
  });
});

describe('auditPrefix', () => {
  it('MCP-13 keeps the prefix and eight characters of the body', () => {
    const token = mintCredential(CREDENTIAL_PREFIX.accessToken, fixedRandom);
    expect(auditPrefix(token)).toBe(`vg_at_${token.slice('vg_at_'.length, 'vg_at_'.length + 8)}`);
    expect(auditPrefix(mintCredential(CREDENTIAL_PREFIX.clientId, fixedRandom))).toMatch(
      /^vg_c_[\w-]{8}$/,
    );
  });
});

describe('isConstantTimeEqual', () => {
  it('OAUTH-23 compares equal strings as equal', () => {
    expect(isConstantTimeEqual('abc', 'abc')).toBe(true);
  });

  it('OAUTH-23 rejects different strings of the same length', () => {
    expect(isConstantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('OAUTH-23 rejects strings of different length without throwing', () => {
    expect(isConstantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
