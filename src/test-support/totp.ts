import { hotp, totpStep } from '../identity/totp.ts';

/**
 * RFC 6238 TOTP for a moment in time: what an authenticator app shows. The
 * server only ever verifies codes (`verifyTotp`), so generating one is a
 * test concern.
 */
export function totp(secret: Buffer, timeMs: number, digits?: number): string {
  return hotp(secret, totpStep(timeMs), digits);
}
