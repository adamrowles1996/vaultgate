import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rate-limit.ts';

function limiterAt(start: number): {
  readonly take: (key: string) => unknown;
  tick: (ms: number) => void;
} {
  let at = start;
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => at });
  return {
    take: (key) => limiter.take(key),
    tick: (ms) => {
      at += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('OPS-6 allows up to the limit then refuses with a Retry-After in seconds', () => {
    const limiter = limiterAt(0);
    expect(limiter.take('a')).toStrictEqual({ allowed: true });
    expect(limiter.take('a')).toStrictEqual({ allowed: true });
    expect(limiter.take('a')).toStrictEqual({ allowed: true });
    expect(limiter.take('a')).toStrictEqual({ allowed: false, retryAfterSeconds: 20 });
  });

  it('OPS-6 keeps keys independent', () => {
    const limiter = limiterAt(0);
    limiter.take('a');
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('b')).toStrictEqual({ allowed: true });
  });

  it('OPS-6 refills evenly over the window', () => {
    const limiter = limiterAt(0);
    limiter.take('a');
    limiter.take('a');
    limiter.take('a');
    limiter.tick(20_000);
    expect(limiter.take('a')).toStrictEqual({ allowed: true });
    expect(limiter.take('a')).toStrictEqual({ allowed: false, retryAfterSeconds: 20 });
  });

  it('OPS-6 forgets a bucket once it is full again', () => {
    const limiter = limiterAt(0);
    limiter.take('a');
    limiter.tick(60_000);
    limiter.take('b');
    limiter.take('a');
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a')).toStrictEqual({ allowed: false, retryAfterSeconds: 20 });
  });

  it('OPS-6 prunes full buckets a few at a time without touching live ones', () => {
    const limiter = limiterAt(0);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      limiter.take(key);
      limiter.take(key);
      limiter.take(key);
    }
    limiter.tick(60_000);
    limiter.take('g');
    limiter.take('g');
    limiter.take('g');
    expect(limiter.take('g')).toStrictEqual({ allowed: false, retryAfterSeconds: 20 });
    limiter.take('f');
    expect(limiter.take('a')).toStrictEqual({ allowed: true });
  });

  it('T21 keeps at most 10 000 keys, evicting the least recently used', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.take('victim')).toStrictEqual({ allowed: true });
    expect(limiter.take('victim').allowed).toBe(false);
    limiter.take('kept');
    for (let index = 0; index < 9998; index += 1) {
      limiter.take(`key-${index}`);
    }
    expect(limiter.take('kept').allowed).toBe(false);
    limiter.take('one-more');
    expect(limiter.take('victim')).toStrictEqual({ allowed: true });
    expect(limiter.take('kept').allowed).toBe(false);
  });

  it('OPS-6 never reports less than one second to wait', () => {
    const limiter = createRateLimiter({ limit: 1000, windowMs: 1000, now: () => 0 });
    for (let index = 0; index < 1000; index += 1) {
      limiter.take('a');
    }
    expect(limiter.take('a')).toStrictEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});
