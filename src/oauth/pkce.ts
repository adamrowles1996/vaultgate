import { createHash } from 'node:crypto';

import { isConstantTimeEqual } from './credentials.ts';

/**
 * RFC 7636 §4.1: 43 to 128 unreserved characters.
 */
const CODE_VERIFIER = /^[\w.~-]{43,128}$/;

/**
 * RFC 7636 §4.2: base64url of a SHA-256 digest is exactly 43 characters.
 */
const CODE_CHALLENGE = /^[\w-]{43}$/;

export const CODE_CHALLENGE_METHOD = 'S256';

export function isValidCodeChallenge(text: string): boolean {
  return CODE_CHALLENGE.test(text);
}

export function isValidCodeVerifier(text: string): boolean {
  return CODE_VERIFIER.test(text);
}

export function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/**
 * OAUTH-23: `base64url(sha256(code_verifier)) === code_challenge`, compared
 * in constant time. A malformed verifier never matches.
 */
export function isCodeVerifierFor(codeVerifier: string, codeChallenge: string): boolean {
  return (
    isValidCodeVerifier(codeVerifier) &&
    isConstantTimeEqual(computeCodeChallenge(codeVerifier), codeChallenge)
  );
}
