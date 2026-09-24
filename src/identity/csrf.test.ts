import { describe, expect, it } from 'vitest';

import { fixedRandom } from '../test-support/identity.ts';

import { generateCsrfToken, isSameOriginRequest, isValidCsrfToken } from './csrf.ts';

const PUBLIC_URL = 'https://vault.example.com';

describe('isSameOriginRequest', () => {
  it('ID-18 accepts an Origin equal to the public origin', () => {
    expect(isSameOriginRequest(new Headers({ origin: PUBLIC_URL }), PUBLIC_URL)).toBe(true);
    expect(isSameOriginRequest(new Headers({ origin: PUBLIC_URL }), `${PUBLIC_URL}/base`)).toBe(
      true,
    );
  });

  it('ID-18 rejects a foreign Origin even with Sec-Fetch-Site: same-origin', () => {
    const headers = new Headers({
      origin: 'https://evil.example',
      'sec-fetch-site': 'same-origin',
    });
    expect(isSameOriginRequest(headers, PUBLIC_URL)).toBe(false);
  });

  it('ID-18 falls back to Sec-Fetch-Site when no Origin is sent', () => {
    expect(isSameOriginRequest(new Headers({ 'sec-fetch-site': 'same-origin' }), PUBLIC_URL)).toBe(
      true,
    );
    expect(isSameOriginRequest(new Headers({ 'sec-fetch-site': 'cross-site' }), PUBLIC_URL)).toBe(
      false,
    );
    expect(isSameOriginRequest(new Headers(), PUBLIC_URL)).toBe(false);
  });

  it('ID-18 treats Origin: null as absent and lets Sec-Fetch-Site decide', () => {
    const sameOrigin = new Headers({ origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(isSameOriginRequest(sameOrigin, PUBLIC_URL)).toBe(true);
    const crossSite = new Headers({ origin: 'null', 'sec-fetch-site': 'cross-site' });
    expect(isSameOriginRequest(crossSite, PUBLIC_URL)).toBe(false);
    expect(isSameOriginRequest(new Headers({ origin: 'null' }), PUBLIC_URL)).toBe(false);
  });
});

describe('isValidCsrfToken', () => {
  it('ID-18 accepts only the exact session token', () => {
    const token = generateCsrfToken(fixedRandom(2));
    expect(token).toBe(Buffer.alloc(32, 2).toString('base64url'));
    expect(isValidCsrfToken(token, token)).toBe(true);
    expect(isValidCsrfToken(`${token.slice(0, -1)}!`, token)).toBe(false);
    expect(isValidCsrfToken(token.slice(1), token)).toBe(false);
    expect(isValidCsrfToken(undefined, token)).toBe(false);
  });

  it('ID-18 refuses a multibyte token of the same code-unit length rather than throwing', () => {
    const token = generateCsrfToken(fixedRandom(2));
    const multibyte = `${'é'.repeat(token.length - 1)}x`;
    expect(multibyte).toHaveLength(token.length);
    expect(Buffer.byteLength(multibyte, 'utf8')).not.toBe(Buffer.byteLength(token, 'utf8'));
    expect(isValidCsrfToken(multibyte, token)).toBe(false);
  });
});
