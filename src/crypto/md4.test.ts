import { describe, expect, it } from 'vitest';

import { md4 } from './md4.ts';

/**
 * RFC 1320 appendix A.5, verbatim. The point of using the specification's own
 * suite rather than another implementation is that a misreading of the
 * algorithm cannot be mirrored in the expectation.
 */
const RFC_1320: readonly (readonly [string, string])[] = [
  ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
  ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
  ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
  ['message digest', 'd9130a8164549fe818874806e1c7014b'],
  ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
  [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    '043f8582f241db351ce627e153e7f0e4',
  ],
  ['1234567890'.repeat(8), 'e33b4ddc9c38f2199c3e7b164fcc0536'],
];

describe('md4', () => {
  it('ACT-89 answers every RFC 1320 test vector', () => {
    const digests = RFC_1320.map(([text]) => md4(Buffer.from(text, 'ascii')).toString('hex'));
    expect(digests).toStrictEqual(RFC_1320.map(([, digest]) => digest));
  });

  it('ACT-89 digests every length across the padding boundaries to sixteen distinct bytes', () => {
    // The RFC suite already spans both padding cases (62 bytes needs a block
    // of its own for the length, 80 does not). This says the rule holds at
    // every length either side of 56 and 64, where an off-by-one would either
    // overflow the buffer or make two lengths collide; there is no published
    // vector for these, so the assertion is the property, never a digest this
    // implementation produced.
    const digests = Array.from({ length: 130 }, (_unused, length) =>
      md4(Buffer.alloc(length, 0x61)).toString('hex'),
    );
    expect(digests.every((digest) => digest.length === 32)).toBe(true);
    expect(new Set(digests).size).toBe(digests.length);
  });
});
