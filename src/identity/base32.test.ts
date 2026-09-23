// cspell:ignore MZXW MZXQ YTBOI fooba foob
import { describe, expect, it } from 'vitest';

import { base32Decode } from '../test-support/base32.ts';

import { base32Encode, randomBase32 } from './base32.ts';

const RFC_4648_VECTORS: readonly (readonly [string, string])[] = [
  ['', ''],
  ['f', 'MY======'],
  ['fo', 'MZXQ===='],
  ['foo', 'MZXW6==='],
  ['foob', 'MZXW6YQ='],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI======'],
];

describe('base32', () => {
  it('ID-8 encodes the RFC 4648 §10 vectors', () => {
    expect(RFC_4648_VECTORS.map(([input]) => base32Encode(Buffer.from(input)))).toStrictEqual(
      RFC_4648_VECTORS.map(([, encoded]) => encoded),
    );
  });

  it('ID-8 round-trips the RFC 4648 §10 vectors through the test decoder, ignoring case and padding', () => {
    expect(
      RFC_4648_VECTORS.map(([, encoded]) =>
        base32Decode(encoded.toLowerCase().replaceAll('=', ''))?.toString(),
      ),
    ).toStrictEqual(RFC_4648_VECTORS.map(([input]) => input));
  });

  it('ID-8 refuses characters outside the alphabet', () => {
    expect(base32Decode('MZXW1===')).toBeUndefined();
  });

  it('ID-11 maps random bytes onto the alphabet', () => {
    expect(randomBase32(Buffer.from([0, 25, 26, 31, 32, 255]))).toBe('AZ27A7');
  });
});
