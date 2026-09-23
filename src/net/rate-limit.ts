/**
 * The in-memory limiters of OPS-6, shared by the authorization server, the
 * MCP endpoint and the actions engine (ACT-59): single replica, no shared
 * state, an injected clock so tests never wait, and at most 10 000 keys each
 * with the least recently used evicted first (T21).
 */

/**
Milliseconds since the epoch, as `Date.now()`.
*/
export type Clock = () => number;

export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimitOptions {
  /**
  Requests allowed per window per key.
  */
  readonly limit: number;
  readonly windowMs: number;
  readonly now: Clock;
}

const SECOND_MS = 1000;

/**
Distinct keys kept at once (T21); beyond it the least recently used entry goes.
*/
const MAX_KEYS = 10_000;

/**
Entries inspected per call, from the least recently used end, so a call costs the same however many keys exist.
*/
const COLD_BATCH = 4;

/**
 * A map kept in last-use order and bounded to `MAX_KEYS`: `put` moves the key
 * to the warm end and evicts the coldest key past the bound; `forgetCold`
 * drops a few stale entries from the cold end per call.
 */
class RecentMap<T> {
  readonly #entries = new Map<string, T>();

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  put(key: string, value: T): void {
    this.#entries.delete(key);
    let excess = this.#entries.size - MAX_KEYS + 1;
    for (const coldest of this.#entries.keys()) {
      if (excess <= 0) {
        break;
      }
      excess -= 1;
      this.#entries.delete(coldest);
    }
    this.#entries.set(key, value);
  }

  forgetCold(isStale: (value: T) => boolean): void {
    let inspected = 0;
    for (const [key, value] of this.#entries) {
      if (inspected >= COLD_BATCH) {
        break;
      }
      inspected += 1;
      if (isStale(value)) {
        this.#entries.delete(key);
      }
    }
  }
}

interface Bucket {
  readonly tokens: number;
  readonly refilledAt: number;
  /**
  The budget the bucket was last taken under; keys of one limiter may differ (ACT-59).
  */
  readonly limit: number;
}

export interface RateLimiter {
  /**
  Spends one token for `key`. A per-call `limit` overrides the limiter's own, so one limiter
  can serve keys with different budgets (a target's `rate_limit_per_minute`, ACT-59); a bucket
  taken under a lower limit than before is clamped to it.
  */
  take(key: string, limit?: number): RateLimitDecision;
}

/**
 * Token bucket per key: `limit` tokens refill evenly over `windowMs`. Full
 * buckets are forgotten a few at a time from the cold end, each judged
 * against its own budget.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const { windowMs, now } = options;
  const buckets = new RecentMap<Bucket>();

  function refilled(bucket: Bucket, at: number, limit: number): Bucket {
    const elapsed = Math.max(0, at - bucket.refilledAt);
    const tokens = Math.min(limit, bucket.tokens + (elapsed * limit) / windowMs);
    return { tokens, refilledAt: at, limit };
  }

  return {
    take(key, limit = options.limit) {
      const at = now();
      buckets.forgetCold((bucket) => refilled(bucket, at, bucket.limit).tokens >= bucket.limit);
      const bucket = refilled(
        buckets.get(key) ?? { tokens: limit, refilledAt: at, limit },
        at,
        limit,
      );
      if (bucket.tokens >= 1) {
        buckets.put(key, { ...bucket, tokens: bucket.tokens - 1 });
        return { allowed: true };
      }
      buckets.put(key, bucket);
      const waitMs = ((1 - bucket.tokens) * windowMs) / limit;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / SECOND_MS)) };
    },
  };
}

interface Window {
  readonly startedAt: number;
  count: number;
}

/**
 * Fixed window per key (MCP-5): `limit` hits from the first hit until
 * `windowMs` later, then a fresh window. Expired windows are forgotten a few
 * at a time from the cold end.
 */
export class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: Clock;
  readonly #windows = new RecentMap<Window>();

  constructor(options: RateLimitOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now;
  }

  #isLive(window: Window, now: number): boolean {
    return window.startedAt + this.#windowMs > now;
  }

  /**
  Counts one hit against `key` and says whether it fits in the current window.
  */
  hit(key: string): RateLimitDecision {
    const now = this.#now();
    this.#windows.forgetCold((window) => !this.#isLive(window, now));
    const existing = this.#windows.get(key);
    const current =
      existing !== undefined && this.#isLive(existing, now)
        ? existing
        : { startedAt: now, count: 0 };
    current.count += 1;
    this.#windows.put(key, current);
    if (current.count <= this.#limit) {
      return { allowed: true };
    }
    const retryAfterMs = current.startedAt + this.#windowMs - now;
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / SECOND_MS) };
  }
}
