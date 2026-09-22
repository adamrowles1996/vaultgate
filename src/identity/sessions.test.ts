import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { fixedRandom } from '../test-support/identity.ts';

import {
  cookiePolicyFor,
  generateSessionId,
  hashSessionId,
  isRecentlyReauthenticated,
  nextSessionExpiry,
  parseCookies,
  serialiseCookie,
} from './sessions.ts';

describe('cookiePolicyFor', () => {
  it('ID-16 uses the __Host- prefix and Secure under https', () => {
    expect(cookiePolicyFor('https://vault.example.com')).toStrictEqual({
      sessionCookieName: '__Host-vg_session',
      stateCookieName: '__Host-vg_state',
      isSecure: true,
    });
  });

  it('ID-16 drops the prefix and Secure for plain-http loopback development', () => {
    expect(cookiePolicyFor('http://localhost:8080')).toStrictEqual({
      sessionCookieName: 'vg_session',
      stateCookieName: 'vg_state',
      isSecure: false,
    });
  });
});

describe('serialiseCookie', () => {
  it('ID-16 sets HttpOnly, SameSite=Lax, Path=/ and Secure', () => {
    expect(serialiseCookie('__Host-vg_session', 'abc', { isSecure: true, maxAgeSeconds: 60 })).toBe(
      '__Host-vg_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60',
    );
  });

  it('ID-17 clears with Max-Age=0 and omits Secure when the policy says so', () => {
    expect(serialiseCookie('vg_session', '', { isSecure: false, maxAgeSeconds: 0 })).toBe(
      'vg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });
});

describe('parseCookies', () => {
  it('ID-16 reads name=value pairs and ignores malformed fragments', () => {
    const cookies = parseCookies('a=1; __Host-vg_session=x=y ;junk; =nope; b=2');
    expect(Object.fromEntries(cookies)).toStrictEqual({
      a: '1',
      '__Host-vg_session': 'x=y',
      b: '2',
    });
    expect(parseCookies(null).size).toBe(0);
  });
});

describe('session ids', () => {
  it('ID-16 draws 32 random bytes as base64url and stores only the SHA-256', () => {
    const id = generateSessionId(fixedRandom(5));
    expect(id).toBe(Buffer.alloc(32, 5).toString('base64url'));
    expect(hashSessionId(id)).toBe(createHash('sha256').update(id).digest('hex'));
  });
});

describe('nextSessionExpiry', () => {
  it('ID-14 refreshes the idle limit on activity up to the absolute limit', () => {
    const hour = 3_600_000;
    expect(nextSessionExpiry(10 * hour, 0, 12 * hour)).toBe(11 * hour);
    expect(nextSessionExpiry(11.5 * hour, 0, 12 * hour)).toBe(12 * hour);
  });
});

describe('isRecentlyReauthenticated', () => {
  it('ID-15 opens a five minute window after re-authentication', () => {
    expect(isRecentlyReauthenticated(undefined, 1000)).toBe(false);
    expect(isRecentlyReauthenticated(1000, 1000 + 5 * 60_000 - 1)).toBe(true);
    expect(isRecentlyReauthenticated(1000, 1000 + 5 * 60_000)).toBe(false);
  });
});
