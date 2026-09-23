import { createHmac } from 'node:crypto';

import { base32Encode } from './base32.ts';
import { MS_PER_SECOND, type RandomSource } from './primitives.ts';

const TOTP_SECRET_BYTES = 20;
const TOTP_DIGITS = 6;
const TOTP_STEP_SECONDS = 30;
const ISSUER = 'vaultgate';
const COUNTER_BYTES = 8;
const DYNAMIC_TRUNCATION_MASK = 0x0f;
const WINDOW = 1;

export function generateTotpSecret(random: RandomSource): Buffer {
  return random(TOTP_SECRET_BYTES);
}

/**
RFC 4226 HOTP with HMAC-SHA1 and dynamic truncation.
*/
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(COUNTER_BYTES);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest.readUInt8(digest.length - 1) & DYNAMIC_TRUNCATION_MASK;
  const binary = digest.readUInt32BE(offset) & 0x7f_ff_ff_ff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
RFC 6238 (ID-8): the 30 s step a time falls in.
*/
export function totpStep(timeMs: number): number {
  return Math.floor(timeMs / MS_PER_SECOND / TOTP_STEP_SECONDS);
}

export interface TotpVerification {
  readonly secret: Buffer;
  readonly code: string;
  readonly nowMs: number;
  /**
  Step of the last accepted code, or `undefined` when none has been accepted.
  */
  readonly lastStep: number | undefined;
}

/**
 * Accepts the current step and one step either side, never a step at or
 * before the last accepted one (ID-10). Returns the accepted step so the
 * caller can persist it, or `undefined` on rejection.
 */
export function verifyTotp({
  secret,
  code,
  nowMs,
  lastStep,
}: TotpVerification): number | undefined {
  if (!/^\d{6}$/.test(code)) {
    return undefined;
  }
  const current = totpStep(nowMs);
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    if (lastStep !== undefined && step <= lastStep) {
      continue;
    }
    if (hotp(secret, step) === code) {
      return step;
    }
  }
  return undefined;
}

export interface Enrolment {
  readonly secretBase32: string;
  readonly uri: string;
}

const DEFAULT_ACCOUNT_LABEL = 'operator';

/**
 * `otpauth://totp/vaultgate:<account>?secret=…&issuer=vaultgate…` (ID-9) plus
 * the manual key. The account label is the operator's e-mail address, or
 * `operator` while none is known (first-run enrolment happens before the
 * address is submitted).
 */
export function describeEnrolment(account: string | undefined, secret: Buffer): Enrolment {
  const secretBase32 = base32Encode(secret).replaceAll('=', '');
  const label = encodeURIComponent(`${ISSUER}:${account ?? DEFAULT_ACCOUNT_LABEL}`);
  const query = new URLSearchParams({
    secret: secretBase32,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return { secretBase32, uri: `otpauth://totp/${label}?${query.toString()}` };
}
