import { timingSafeEqual } from 'node:crypto';

import type { RandomSource } from './primitives.ts';

const CSRF_TOKEN_BYTES = 32;

export function generateCsrfToken(random: RandomSource): string {
  return random(CSRF_TOKEN_BYTES).toString('base64url');
}

/**
 * The browser-hardening half of ID-18: the request must carry an `Origin`
 * equal to the public origin, or (when no `Origin` is sent) a
 * `Sec-Fetch-Site: same-origin` header.
 */
export function isSameOriginRequest(headers: Headers, publicUrl: string): boolean {
  const origin = headers.get('origin');
  return origin === null
    ? headers.get('sec-fetch-site') === 'same-origin'
    : origin === new URL(publicUrl).origin;
}

/**
 * The synchroniser half of ID-18: the form token must equal the one bound to
 * the session. The lengths compared are the byte lengths the buffers will
 * have, not the code-unit lengths of the strings: a submitted token of the
 * same code-unit length but a different byte length made `timingSafeEqual`
 * throw a `RangeError`, which left the route as a 500 with no audit event
 * where ID-18 requires a 403 with one.
 */
export function isValidCsrfToken(submitted: string | undefined, expected: string): boolean {
  if (submitted === undefined) {
    return false;
  }
  const presented = Buffer.from(submitted, 'utf8');
  const bound = Buffer.from(expected, 'utf8');
  return presented.length === bound.length && timingSafeEqual(presented, bound);
}
