import { describe, expect, it } from 'vitest';

import { combineScrubbers } from './combined-scrub.ts';
import { createScrubber } from './scrub.ts';

const ALPHA = 'alpha-secret-111';
const BETA = 'beta-secret-22222222';

function both() {
  return combineScrubbers(
    createScrubber([{ field: 'password', value: Buffer.from(ALPHA) }], undefined),
    [createScrubber([{ field: 'custom.key', value: Buffer.from(BETA) }], undefined)],
  );
}

describe('the scrubber of a call over several targets (ACT-51, ACT-110)', () => {
  it("ACT-51 redacts every target's values in text, bytes and anything deep", () => {
    const scrub = both();
    const text = `${ALPHA} and ${encodeURIComponent(BETA)}`;
    expect(scrub.text(text)).toBe('[redacted:password] and [redacted:custom.key]');
    expect(scrub.bytes(Buffer.from(text)).toString()).toBe(
      '[redacted:password] and [redacted:custom.key]',
    );
    expect(
      scrub.deep({ list: [ALPHA, { nested: Buffer.from(BETA).toString('base64') }], n: 1 }),
    ).toStrictEqual({
      list: ['[redacted:password]', { nested: '[redacted:custom.key]' }],
      n: 1,
    });
  });

  it('ACT-52 the guard band is the longest variant of any target', () => {
    const alpha = createScrubber([{ field: 'password', value: Buffer.from(ALPHA) }], undefined);
    const beta = createScrubber([{ field: 'custom.key', value: Buffer.from(BETA) }], undefined);
    expect(combineScrubbers(alpha, [beta]).guardBytes).toBe(
      Math.max(alpha.guardBytes, beta.guardBytes),
    );
    expect(combineScrubbers(beta, [alpha]).guardBytes).toBe(beta.guardBytes);
  });

  it('ACT-52 a capped buffer is scrubbed by every table before it is cut, and reports the bytes captured', () => {
    const scrub = both();
    const input = Buffer.from(`${BETA}${'x'.repeat(40)}`);
    const capped = scrub.buffer(input, 30);
    expect(capped).toStrictEqual({
      text: '[redacted:custom.key]xxxxxxxxx',
      truncated: true,
      bytes: input.length,
    });
    const whole = scrub.buffer(Buffer.from(`${ALPHA}!`), 1000);
    expect(whole).toStrictEqual({
      text: '[redacted:password]!',
      truncated: false,
      bytes: ALPHA.length + 1,
    });
  });

  it('ACT-51 ACT-52 a capped buffer the engine encodes is scrubbed as bytes first, then encoded and cut', () => {
    const scrub = both();
    const input = Buffer.from(BETA);
    const capped = scrub.base64(input, 1000);
    expect(Buffer.from(capped.text, 'base64').toString()).toBe('[redacted:custom.key]');
    expect([capped.truncated, capped.bytes]).toStrictEqual([false, input.length]);
    const cut = scrub.base64(Buffer.from('y'.repeat(300)), 16);
    expect([cut.text.length, cut.truncated]).toStrictEqual([16, true]);
  });

  it('ACT-52 an output larger than the cap is truncated even when scrubbing shortened it below the cap', () => {
    const long = 'z'.repeat(64);
    const scrub = combineScrubbers(createScrubber([], undefined), [
      createScrubber([{ field: 'k', value: Buffer.from(long) }], undefined),
    ]);
    expect(scrub.buffer(Buffer.from(long), 32)).toStrictEqual({
      text: '[redacted:k]',
      truncated: true,
      bytes: 64,
    });
  });
});
