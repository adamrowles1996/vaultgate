import { type Clock, SECOND_MS } from './clock.ts';

export interface RateLimitOptions {
  /**
  Requests allowed per window per key.
  */
  readonly limit: number;
  readonly windowMs: number;
  readonly now: Clock;
}

type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  take(key: string): RateLimitDecision;
}

interface Bucket {
  readonly tokens: number;
  readonly refilledAt: number;
}

/**
Distinct keys kept at once (T21); beyond it the least recently used bucket goes.
*/
const MAX_KEYS = 10_000;

/**
Buckets inspected per call, from the least recently used end, so a call costs the same however many keys exist.
*/
const PRUNE_BATCH = 4;

/**
 * In-memory token bucket per key (OPS-6): `limit` tokens refill evenly over
 * `windowMs`. The map is kept in last-use order: full buckets are forgotten
 * a few at a time from the cold end, and past `MAX_KEYS` the coldest bucket
 * is evicted, so memory stays bounded whatever an attacker does with keys.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const { limit, windowMs, now } = options;
  const refillPerMs = limit / windowMs;
  const buckets = new Map<string, Bucket>();

  function refilled(bucket: Bucket, at: number): Bucket {
    const elapsed = Math.max(0, at - bucket.refilledAt);
    return { tokens: Math.min(limit, bucket.tokens + elapsed * refillPerMs), refilledAt: at };
  }

  function prune(at: number): void {
    let inspected = 0;
    for (const [key, bucket] of buckets) {
      if (inspected >= PRUNE_BATCH) {
        break;
      }
      inspected += 1;
      if (refilled(bucket, at).tokens >= limit) {
        buckets.delete(key);
      }
    }
  }

  function makeRoom(): void {
    let excess = buckets.size - MAX_KEYS + 1;
    for (const coldest of buckets.keys()) {
      if (excess <= 0) {
        break;
      }
      excess -= 1;
      buckets.delete(coldest);
    }
  }

  return {
    take(key) {
      const at = now();
      prune(at);
      const bucket = refilled(buckets.get(key) ?? { tokens: limit, refilledAt: at }, at);
      buckets.delete(key);
      makeRoom();
      if (bucket.tokens >= 1) {
        buckets.set(key, { tokens: bucket.tokens - 1, refilledAt: at });
        return { allowed: true };
      }
      buckets.set(key, bucket);
      const waitMs = (1 - bucket.tokens) / refillPerMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / SECOND_MS)) };
    },
  };
}
