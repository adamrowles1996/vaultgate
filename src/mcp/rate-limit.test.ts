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

  it('OPS-6 evicts expired windows a few at a time and restarts a stale one on its next hit', () => {
    const { limiter: subject, clock } = limiter(1);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      subject.hit(key);
    }
    clock.advance(60_000);
    expect(subject.hit('f')).toStrictEqual({ allowed: true });
    expect(subject.hit('f').allowed).toBe(false);
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
  });

  it('T21 keeps at most 10 000 keys, evicting the least recently used', () => {
    const { limiter: subject } = limiter(1);
    expect(subject.hit('victim')).toStrictEqual({ allowed: true });
    expect(subject.hit('victim').allowed).toBe(false);
    subject.hit('kept');
    for (let index = 0; index < 9998; index += 1) {
      subject.hit(`key-${index}`);
    }
    expect(subject.hit('kept').allowed).toBe(false);
    subject.hit('one-more');
    expect(subject.hit('victim')).toStrictEqual({ allowed: true });
    expect(subject.hit('kept').allowed).toBe(false);
  });

  it('MCP-5 starts a fresh window once the previous one has elapsed', () => {
    const { limiter: subject, clock } = limiter(1);
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
    expect(subject.hit('a').allowed).toBe(false);
    clock.advance(60_000);
    expect(subject.hit('a')).toStrictEqual({ allowed: true });
  });
});
