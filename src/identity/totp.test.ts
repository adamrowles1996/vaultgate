// cspell:ignore GEZDGNBVGY TQOJQGEZDGNBVGY TQOJQ
import { describe, expect, it } from 'vitest';

import { fixedRandom } from '../test-support/identity.ts';

import { describeEnrolment, generateTotpSecret, hotp, totp, verifyTotp } from './totp.ts';

const SECRET = Buffer.from('12345678901234567890');
const STEP_MS = 30_000;

// RFC 6238 Appendix B, HMAC-SHA1 column, truncated to six digits.
const RFC_6238_VECTORS: readonly (readonly [number, string])[] = [
  [59, '287082'],
  [1_111_111_109, '081804'],
  [1_111_111_111, '050471'],
  [1_234_567_890, '005924'],
  [2_000_000_000, '279037'],
  [20_000_000_000, '353130'],
];

// RFC 4226 Appendix D, counters 0 to 9.
const RFC_4226_VECTORS = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
];

describe('totp', () => {
  it('ID-8 reproduces the RFC 6238 Appendix B SHA-1 vectors', () => {
    expect(RFC_6238_VECTORS.map(([seconds]) => totp(SECRET, seconds * 1000))).toStrictEqual(
      RFC_6238_VECTORS.map(([, code]) => code),
    );
  });

  it('ID-8 reproduces the RFC 4226 Appendix D HOTP vectors', () => {
    expect(RFC_4226_VECTORS.map((_, counter) => hotp(SECRET, counter))).toStrictEqual(
      RFC_4226_VECTORS,
    );
  });

  it('ID-8 supports eight digits for the full RFC vector', () => {
    expect(totp(SECRET, 59_000, 8)).toBe('94287082');
  });

  it('ID-9 draws a 20-byte secret', () => {
    expect(generateTotpSecret(fixedRandom(3))).toStrictEqual(Buffer.alloc(20, 3));
  });
});

describe('verifyTotp', () => {
  const nowMs = 1_111_111_111 * 1000;
  const currentStep = Math.floor(nowMs / STEP_MS);

  it('ID-10 accepts the current step and one either side', () => {
    const codes = [nowMs - STEP_MS, nowMs, nowMs + STEP_MS].map((time) => totp(SECRET, time));
    expect(
      codes.map((code) => verifyTotp({ secret: SECRET, code, nowMs, lastStep: undefined })),
    ).toStrictEqual([currentStep - 1, currentStep, currentStep + 1]);
  });

  it('ID-10 rejects codes two steps away', () => {
    const code = totp(SECRET, nowMs + 2 * STEP_MS);
    expect(verifyTotp({ secret: SECRET, code, nowMs, lastStep: undefined })).toBeUndefined();
  });

  it('ID-10 rejects a replay at or before the last accepted step', () => {
    const code = totp(SECRET, nowMs);
    expect(verifyTotp({ secret: SECRET, code, nowMs, lastStep: currentStep })).toBeUndefined();
    const next = totp(SECRET, nowMs + STEP_MS);
    expect(verifyTotp({ secret: SECRET, code: next, nowMs, lastStep: currentStep })).toBe(
      currentStep + 1,
    );
  });

  it('ID-10 rejects anything that is not six digits', () => {
    expect(
      verifyTotp({ secret: SECRET, code: '12345', nowMs, lastStep: undefined }),
    ).toBeUndefined();
    expect(
      verifyTotp({ secret: SECRET, code: 'abcdef', nowMs, lastStep: undefined }),
    ).toBeUndefined();
  });
});

describe('describeEnrolment', () => {
  it('ID-9 builds the otpauth URI and the manual key', () => {
    const enrolment = describeEnrolment('Ada Lovelace', SECRET);
    expect(enrolment.secretBase32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(enrolment.uri).toBe(
      'otpauth://totp/vaultgate%3AAda%20Lovelace?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=vaultgate&algorithm=SHA1&digits=6&period=30',
    );
  });
});
