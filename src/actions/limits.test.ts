import { describe, expect, it } from 'vitest';

import { type ActionLimits, createActionLimits, type LimitKey } from './limits.ts';

function harness(): { limits: ActionLimits; tick: (ms: number) => void } {
  let at = 0;
  return {
    limits: createActionLimits(() => at),
    tick: (ms) => {
      at += ms;
    },
  };
}

function acquire(limits: ActionLimits, key: LimitKey): () => void {
  const decision = limits.acquire(key);
  if (!decision.allowed) {
    throw new Error(
      `expected the call to be allowed, got retry after ${decision.retryAfterSeconds}`,
    );
  }
  return decision.release;
}

const KEY: LimitKey = { targetId: 't1', clientId: 'c1', targetPerMinute: 600 };

describe('createActionLimits', () => {
  it('ACT-59 limits calls per target to the policy value per minute and answers retry_after in seconds', () => {
    const { limits, tick } = harness();
    const key = { ...KEY, targetPerMinute: 2 };
    acquire(limits, key)();
    acquire(limits, key)();
    expect(limits.acquire(key)).toStrictEqual({ allowed: false, retryAfterSeconds: 30 });
    tick(30_000);
    acquire(limits, key)();
    expect(limits.acquire({ ...key, targetId: 't2' }).allowed).toBe(true);
  });

  it('ACT-59 limits calls per client to 120 per minute across every target', () => {
    const { limits } = harness();
    for (let index = 0; index < 120; index += 1) {
      acquire(limits, { ...KEY, targetId: `t${index}` })();
    }
    expect(limits.acquire({ ...KEY, targetId: 'fresh' })).toStrictEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limits.acquire({ ...KEY, targetId: 'fresh', clientId: 'c2' }).allowed).toBe(true);
  });

  it('ACT-59 holds at most 4 calls in flight per target and 8 per client, and releases exactly once', () => {
    const { limits } = harness();
    const releases = Array.from({ length: 4 }, () => acquire(limits, KEY));
    expect(limits.acquire(KEY)).toStrictEqual({ allowed: false, retryAfterSeconds: 1 });
    releases[0]?.();
    releases[0]?.();
    releases.push(acquire(limits, KEY));
    expect(limits.acquire(KEY).allowed).toBe(false);
    for (const targetId of ['t2', 't3', 't4', 't5']) {
      releases.push(acquire(limits, { ...KEY, targetId }));
    }
    expect(limits.acquire({ ...KEY, targetId: 't6' })).toStrictEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limits.acquire({ ...KEY, targetId: 't6', clientId: 'c2' }).allowed).toBe(true);
    for (const release of releases) {
      release();
    }
    expect(limits.acquire({ ...KEY, targetId: 't6' }).allowed).toBe(true);
    expect(limits.acquire(KEY).allowed).toBe(true);
  });
});
