import { describe, expect, it } from 'vitest';

import { createRateLimiter, FixedWindowRateLimiter } from './rate-limit.ts';

function limiterAt(start: number): {
  readonly take: (key: string, limit?: number) => unknown;
  tick: (ms: number) => void;
} {
  let at = start;
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => at });
  return {
    take: (key, limit) => limiter.take(key, limit),
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

  it('ACT-59 honours a per-call limit for a key, refilling at that rate', () => {
    const limiter = limiterAt(0);
    expect(limiter.take('target', 1)).toStrictEqual({ allowed: true });
    expect(limiter.take('target', 1)).toStrictEqual({ allowed: false, retryAfterSeconds: 60 });
    limiter.tick(30_000);
    expect(limiter.take('target', 1)).toStrictEqual({ allowed: false, retryAfterSeconds: 30 });
    limiter.tick(30_000);
    expect(limiter.take('target', 1)).toStrictEqual({ allowed: true });
  });

  it('ACT-59 clamps a bucket to a lowered per-call limit', () => {
    const limiter = limiterAt(0);
    limiter.take('target', 5);
    expect(limiter.take('target', 1)).toStrictEqual({ allowed: true });
    expect(limiter.take('target', 1)).toStrictEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('ACT-59 judges a cold bucket against its own budget, never the default one', () => {
    const limiter = limiterAt(0);
    expect(limiter.take('target', 2)).toStrictEqual({ allowed: true });
    expect(limiter.take('target', 2)).toStrictEqual({ allowed: true });
    expect(limiter.take('target', 2)).toStrictEqual({ allowed: false, retryAfterSeconds: 30 });
    limiter.tick(30_000);
    expect(limiter.take('target', 2)).toStrictEqual({ allowed: true });
    expect(limiter.take('target', 2)).toStrictEqual({ allowed: false, retryAfterSeconds: 30 });
  });
});

function fixedWindow(limit: number): {
  limiter: FixedWindowRateLimiter;
  tick: (ms: number) => void;
} {
  let at = 0;
  return {
    limiter: new FixedWindowRateLimiter({ limit, windowMs: 60_000, now: () => at }),
    tick: (ms) => {
      at += ms;
    },
  };
}

describe('FixedWindowRateLimiter', () => {
  it('MCP-5 allows exactly the limit within a window and then refuses with a retry delay', () => {
    const { limiter, tick } = fixedWindow(2);
    expect(limiter.hit('a')).toStrictEqual({ allowed: true });
    expect(limiter.hit('a')).toStrictEqual({ allowed: true });
    tick(1500);
    expect(limiter.hit('a')).toStrictEqual({ allowed: false, retryAfterSeconds: 59 });
  });

  it('OPS-6 keys windows independently', () => {
    const { limiter } = fixedWindow(1);
    expect(limiter.hit('a')).toStrictEqual({ allowed: true });
    expect(limiter.hit('b')).toStrictEqual({ allowed: true });
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('OPS-6 evicts expired windows a few at a time and restarts a stale one on its next hit', () => {
    const { limiter, tick } = fixedWindow(1);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      limiter.hit(key);
    }
    tick(60_000);
    expect(limiter.hit('f')).toStrictEqual({ allowed: true });
    expect(limiter.hit('f').allowed).toBe(false);
    expect(limiter.hit('a')).toStrictEqual({ allowed: true });
  });

  it('T21 keeps at most 10 000 keys, evicting the least recently used', () => {
    const { limiter } = fixedWindow(1);
    expect(limiter.hit('victim')).toStrictEqual({ allowed: true });
    expect(limiter.hit('victim').allowed).toBe(false);
    limiter.hit('kept');
    for (let index = 0; index < 9998; index += 1) {
      limiter.hit(`key-${index}`);
    }
    expect(limiter.hit('kept').allowed).toBe(false);
    limiter.hit('one-more');
    expect(limiter.hit('victim')).toStrictEqual({ allowed: true });
    expect(limiter.hit('kept').allowed).toBe(false);
  });

  it('MCP-5 starts a fresh window once the previous one has elapsed', () => {
    const { limiter, tick } = fixedWindow(1);
    expect(limiter.hit('a')).toStrictEqual({ allowed: true });
    expect(limiter.hit('a').allowed).toBe(false);
    tick(60_000);
    expect(limiter.hit('a')).toStrictEqual({ allowed: true });
  });
});
