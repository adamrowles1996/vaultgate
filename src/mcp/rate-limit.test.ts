import { describe, expect, it } from 'vitest';

import { FakeClock } from '../test-support/test-app.ts';

import { FixedWindowRateLimiter } from './rate-limit.ts';

function limiter(limit: number): { limiter: FixedWindowRateLimiter; clock: FakeClock } {
  const clock = new FakeClock();
  return {
    limiter: new FixedWindowRateLimiter({ limit, windowMs: 60_000, now: () => clock.now() }),
    clock,
  };
}

describe('FixedWindowRateLimiter', () => {
  it('MCP-5 allows exactly the limit within a window and then refuses with a retry delay', () => {
    const { limiter: subject, clock } = limiter(2);
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
    clock.advance(1500);
    expect(subject.hit('a')).toStrictEqual({ allowed: false, retryAfterSeconds: 59 });
  });

  it('OPS-6 keys windows independently', () => {
    const { limiter: subject } = limiter(1);
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
    expect(subject.hit('b')).toStrictEqual({ allowed: true });
    expect(subject.hit('a').allowed).toBe(false);
  });

  it('MCP-5 starts a fresh window once the previous one has elapsed', () => {
    const { limiter: subject, clock } = limiter(1);
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
    expect(subject.hit('a').allowed).toBe(false);
    clock.advance(60_000);
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
  });
});
