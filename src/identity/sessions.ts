import { createHash } from 'node:crypto';

import { MS_PER_HOUR, MS_PER_MINUTE, type RandomSource } from './primitives.ts';

const SESSION_ID_BYTES = 32;
const SESSION_IDLE_TTL_MS = MS_PER_HOUR;
const REAUTHENTICATION_WINDOW_MS = 5 * MS_PER_MINUTE;
const COOKIE_BASE_NAME = 'vg_session';
const STATE_COOKIE_BASE_NAME = 'vg_state';

export interface CookiePolicy {
  readonly sessionCookieName: string;
  readonly stateCookieName: string;
  /**
  False only for plain-http loopback development (ID-16).
  */
  readonly isSecure: boolean;
}

/**
`__Host-` prefixed and `Secure` under https; both dropped for `http://localhost` development.
*/
export function cookiePolicyFor(publicUrl: string): CookiePolicy {
  const isSecure = new URL(publicUrl).protocol === 'https:';
  const prefix = isSecure ? '__Host-' : '';
  return {
    sessionCookieName: `${prefix}${COOKIE_BASE_NAME}`,
    stateCookieName: `${prefix}${STATE_COOKIE_BASE_NAME}`,
    isSecure,
  };
}

export interface CookieAttributes {
  readonly isSecure: boolean;
  readonly maxAgeSeconds: number;
}

/**
`HttpOnly; SameSite=Lax; Path=/` always; `Secure` per policy; `Max-Age=0` clears (ID-16, ID-17).
*/
export function serialiseCookie(name: string, value: string, attributes: CookieAttributes): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (attributes.isSecure) {
    parts.push('Secure');
  }
  parts.push(`Max-Age=${attributes.maxAgeSeconds}`);
  return parts.join('; ');
}

export function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  const pairs = (header ?? '').split(';');
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    const name = pair.slice(0, Math.max(separator, 0)).trim();
    if (name.length > 0) {
      cookies.set(name, pair.slice(separator + 1).trim());
    }
  }
  return cookies;
}

export function generateSessionId(random: RandomSource): string {
  return random(SESSION_ID_BYTES).toString('base64url');
}

export function hashSessionId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

/**
Idle expiry refreshed on activity, never beyond the absolute limit (ID-14).
*/
export function nextSessionExpiry(now: number, createdAt: number, absoluteTtlMs: number): number {
  return Math.min(now + SESSION_IDLE_TTL_MS, createdAt + absoluteTtlMs);
}

export function isRecentlyReauthenticated(
  reauthenticatedAt: number | undefined,
  now: number,
): boolean {
  return reauthenticatedAt !== undefined && now - reauthenticatedAt < REAUTHENTICATION_WINDOW_MS;
}
