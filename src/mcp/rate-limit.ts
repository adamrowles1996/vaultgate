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

/**
Distinct keys kept at once (T21); beyond it the least recently used window goes.
*/
const MAX_KEYS = 10_000;

/**
Windows inspected per hit, from the least recently used end, so a hit costs the same however many keys exist.
*/
const EVICT_BATCH = 4;

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

  #isLive(window: Window, now: number): boolean {
    return window.startedAt + this.#windowMs > now;
  }

  #evictExpired(now: number): void {
    let inspected = 0;
    for (const [key, window] of this.#windows) {
      if (inspected >= EVICT_BATCH) {
        break;
      }
      inspected += 1;
      if (!this.#isLive(window, now)) {
        this.#windows.delete(key);
      }
    }
  }

  #makeRoom(): void {
    let excess = this.#windows.size - MAX_KEYS + 1;
    for (const coldest of this.#windows.keys()) {
      if (excess <= 0) {
        break;
      }
      excess -= 1;
      this.#windows.delete(coldest);
    }
  }

  #liveWindow(key: string, now: number): Window {
    const existing = this.#windows.get(key);
    return existing !== undefined && this.#isLive(existing, now)
      ? existing
      : { startedAt: now, count: 0 };
  }

  /**
  Counts one hit against `key` and says whether it fits in the current window.
  The map is kept in last-use order so eviction always takes the coldest key.
  */
  hit(key: string): RateLimitDecision {
    const now = this.#now();
    this.#evictExpired(now);
    const current = this.#liveWindow(key, now);
    current.count += 1;
    this.#windows.delete(key);
    this.#makeRoom();
    this.#windows.set(key, current);
    if (current.count <= this.#limit) {
      return { allowed: true };
    }
    const retryAfterMs = current.startedAt + this.#windowMs - now;
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / MS_PER_SECOND) };
  }
}
