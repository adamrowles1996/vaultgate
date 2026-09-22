import { type Clock, SECOND_MS } from './clock.ts';

export interface RateLimitOptions {
  /**
  Requests allowed per window per key.
  */
  readonly limit: number;
  readonly windowMs: number;
  readonly now: Clock;
}

export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  take(key: string): RateLimitDecision;
}

interface Bucket {
  tokens: number;
  refilledAt: number;
}

/**
 * In-memory token bucket per key (OPS-6): `limit` tokens refill evenly over
 * `windowMs`. Full buckets are forgotten so memory stays bounded by the set
 * of keys seen inside one window.
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
    for (const [key, bucket] of buckets) {
      const current = refilled(bucket, at);
      if (current.tokens >= limit) {
        buckets.delete(key);
      } else {
        buckets.set(key, current);
      }
    }
  }

  return {
    take(key) {
      const at = now();
      prune(at);
      const bucket = buckets.get(key) ?? { tokens: limit, refilledAt: at };
      if (bucket.tokens >= 1) {
        buckets.set(key, { tokens: bucket.tokens - 1, refilledAt: at });
        return { allowed: true };
      }
      const waitMs = (1 - bucket.tokens) / refillPerMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / SECOND_MS)) };
    },
  };
}
