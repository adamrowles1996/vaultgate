import { describe, expect, it } from 'vitest';

import { HOUR_MS, MINUTE_MS, SECOND_MS, toSeconds } from './clock.ts';

describe('clock constants', () => {
  it('derive from one second', () => {
    expect(MINUTE_MS).toBe(60 * SECOND_MS);
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
  });
});

describe('toSeconds', () => {
  it('rounds up so a client never believes a token outlives the server', () => {
    expect(toSeconds(3_600_000)).toBe(3600);
    expect(toSeconds(1)).toBe(1);
  });
});
