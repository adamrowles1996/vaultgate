import { describe, expect, it } from 'vitest';

import {
  CODE_CHALLENGE_METHOD,
  computeCodeChallenge,
  isCodeVerifierFor,
  isValidCodeChallenge,
  isValidCodeVerifier,
} from './pkce.ts';

/**
 * RFC 7636 Appendix B.
 */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('computeCodeChallenge', () => {
  it('OAUTH-23 reproduces the RFC 7636 Appendix B vector', () => {
    expect(computeCodeChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
    expect(CODE_CHALLENGE_METHOD).toBe('S256');
  });
});

describe('isCodeVerifierFor', () => {
  it('OAUTH-23 accepts the matching verifier', () => {
    expect(isCodeVerifierFor(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it('OAUTH-23 rejects a verifier that does not match', () => {
    expect(isCodeVerifierFor(`${RFC_VERIFIER.slice(0, -1)}X`, RFC_CHALLENGE)).toBe(false);
  });

  it('OAUTH-23 rejects a malformed verifier before hashing', () => {
    expect(isCodeVerifierFor('too-short', computeCodeChallenge('too-short'))).toBe(false);
  });
});

describe('isValidCodeVerifier', () => {
  it('RFC 7636 §4.1 requires 43 to 128 unreserved characters', () => {
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(42)}!`)).toBe(false);
  });
});

describe('isValidCodeChallenge', () => {
  it('RFC 7636 §4.2 requires exactly 43 base64url characters', () => {
    expect(isValidCodeChallenge(RFC_CHALLENGE)).toBe(true);
    expect(isValidCodeChallenge(`${RFC_CHALLENGE}=`)).toBe(false);
    expect(isValidCodeChallenge(RFC_CHALLENGE.slice(1))).toBe(false);
  });
});
