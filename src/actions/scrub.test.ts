import { describe, expect, it } from 'vitest';

import { createScrubber, redactionMarker, scrubVariants } from './scrub.ts';

const SECRET = 'p@ss word/+=';

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('scrubVariants', () => {
  it('ACT-51 yields the raw value and every encoded form, longest first, without duplicates', () => {
    const variants = scrubVariants(SECRET, 'alice');
    expect(new Set(variants)).toStrictEqual(
      new Set([
        SECRET,
        'p%40ss%20word%2F%2B%3D',
        'p%40ss+word%2F%2B%3D',
        base64(SECRET),
        Buffer.from(SECRET).toString('base64url'),
        base64(`alice:${SECRET}`),
      ]),
    );
    expect(variants).toStrictEqual(variants.toSorted((left, right) => right.length - left.length));
    expect(variants).toHaveLength(new Set(variants).size);
  });

  it('ACT-51 includes base64 and base64url with and without padding', () => {
    expect(scrubVariants('x')).toStrictEqual(['eA==', 'eA', 'x']);
    expect(scrubVariants('xy')).toStrictEqual(['eHk=', 'eHk', 'xy']);
  });

  it(
    String.raw`ACT-51 includes the JSON string escape and, for values outside printable ASCII, the \uXXXX form`,
    () => {
      const value = 'a"b\\ü\u{1F600}\n';
      const variants = scrubVariants(value);
      expect(variants).toContain(String.raw`a\"b\\ü😀\n`);
      expect(variants).toContain(String.raw`a\"b\\\u00fc\ud83d\ude00\n`);
      expect(scrubVariants('a"b')).toContain(String.raw`a\"b`);
      expect(scrubVariants('a"b')).toHaveLength(4);
    },
  );

  it('ACT-51 has no variants for an empty value, which would otherwise match everything', () => {
    expect(scrubVariants('')).toStrictEqual([]);
  });
});

describe('createScrubber', () => {
  const entries = [
    { field: 'password', value: Buffer.from(SECRET) },
    { field: 'custom.api-key', value: Buffer.from('k') },
  ];

  it('ACT-51 replaces every variant of every injected value with the redaction marker, whatever its length', () => {
    const scrubber = createScrubber(entries, 'alice');
    const text =
      `plain=${SECRET} url=${encodeURIComponent(SECRET)} b64=${base64(SECRET)} ` +
      `basic=${base64(`alice:${SECRET}`)} json=${JSON.stringify(SECRET)} k`;
    expect(scrubber.text(text)).toBe(
      'plain=[redacted:password] url=[redacted:password] b64=[redacted:password] ' +
        'basic=[redacted:password] json="[redacted:password]" [redacted:custom.api-key]',
    );
    expect(scrubber.text('key')).toBe(`${redactionMarker('custom.api-key')}ey`);
    expect(scrubber.text('raw')).toBe(`r${redactionMarker('custom.api-key')}`);
    expect(scrubber.guardBytes).toBe(base64(`alice:${SECRET}`).length);
  });

  it('ACT-52 scrubs the buffered output before cutting it, so a value straddling the cut cannot survive', () => {
    const scrubber = createScrubber(
      [{ field: 'password', value: Buffer.from('SECRET-VALUE') }],
      undefined,
    );
    expect(scrubber.guardBytes).toBe(16);
    const capped = scrubber.buffer(Buffer.from('abcdefghSECRET-VALUEtail'), 10);
    expect(capped).toStrictEqual({ text: 'abcdefgh[r', truncated: true, bytes: 24 });
  });

  it('ACT-52 reports truncation when the scrubbed text outgrows the cap or the input did', () => {
    const scrubber = createScrubber([{ field: 'p', value: Buffer.from('x') }], undefined);
    expect(scrubber.buffer(Buffer.from('ax'), 5)).toStrictEqual({
      text: 'a[red',
      truncated: true,
      bytes: 2,
    });
    expect(scrubber.buffer(Buffer.from('abc'), 5)).toStrictEqual({
      text: 'abc',
      truncated: false,
      bytes: 3,
    });
    expect(scrubber.buffer(Buffer.from('abcdef'), 5)).toStrictEqual({
      text: 'abcde',
      truncated: true,
      bytes: 6,
    });
  });

  it('ACT-51 scrubs every string inside a nested value and leaves other types alone', () => {
    const scrubber = createScrubber([{ field: 'password', value: Buffer.from(SECRET) }], undefined);
    expect(
      scrubber.deep({
        a: [SECRET, 1, null, { b: `x${base64(SECRET)}y`, c: true }],
        d: undefined,
      }),
    ).toStrictEqual({
      a: ['[redacted:password]', 1, null, { b: 'x[redacted:password]y', c: true }],
      d: undefined,
    });
  });

  it('ACT-50 keeps working after the injected buffers have been zeroed', () => {
    const value = Buffer.from(SECRET);
    const scrubber = createScrubber([{ field: 'password', value }], undefined);
    value.fill(0);
    expect(scrubber.text(SECRET)).toBe('[redacted:password]');
  });

  it('is a no-op without injected values', () => {
    const scrubber = createScrubber([], undefined);
    expect(scrubber.guardBytes).toBe(0);
    expect(scrubber.text('anything')).toBe('anything');
  });
});
