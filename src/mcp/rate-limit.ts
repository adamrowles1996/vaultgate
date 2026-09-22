/**
 * In-memory fixed-window counter (spec §10.4, OPS-6): single replica, no
 * shared state. The clock is injected so tests never wait.
 */
export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
}

interface Window {
  readonly startedAt: number;
  count: number;
}

const MS_PER_SECOND = 1000;

export class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(options: RateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now;
  }

  #evictExpired(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.startedAt + this.#windowMs <= now) {
        this.#windows.delete(key);
      }
    }
  }

  /**
  Counts one hit against `key` and says whether it fits in the current window.
  */
  hit(key: string): RateLimitDecision {
    const now = this.#now();
    this.#evictExpired(now);
    const current = this.#windows.get(key) ?? { startedAt: now, count: 0 };
    current.count += 1;
    this.#windows.set(key, current);
    if (current.count <= this.#limit) {
      return { allowed: true };
    }
    const retryAfterMs = current.startedAt + this.#windowMs - now;
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / MS_PER_SECOND) };
  }
}
