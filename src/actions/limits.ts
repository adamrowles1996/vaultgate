/**
 * Rate limits and caps (spec §13.11, ACT-59): per-target and per-client
 * token buckets on the shared limiter of OPS-6, plus in-flight counters. A
 * call acquires all four before confirmation and releases the counters when
 * it ends.
 */
import { type Clock, createRateLimiter } from '../net/rate-limit.ts';

const MINUTE_MS = 60_000;
const CLIENT_CALLS_PER_MINUTE = 120;
const TARGET_IN_FLIGHT = 4;
const CLIENT_IN_FLIGHT = 8;
const IN_FLIGHT_RETRY_SECONDS = 1;

export interface LimitKey {
  readonly targetId: string;
  readonly clientId: string;
  /**
  The target's `policy.rate_limit_per_minute`.
  */
  readonly targetPerMinute: number;
}

export type LimitDecision =
  | { readonly allowed: true; readonly release: () => void }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface ActionLimits {
  acquire(key: LimitKey): LimitDecision;
}

class InFlight {
  readonly #counts = new Map<string, number>();

  count(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  enter(key: string): () => void {
    this.#counts.set(key, this.count(key) + 1);
    let isReleased = false;
    return () => {
      if (isReleased) {
        return;
      }
      isReleased = true;
      const remaining = this.count(key) - 1;
      if (remaining === 0) {
        this.#counts.delete(key);
      } else {
        this.#counts.set(key, remaining);
      }
    };
  }
}

export function createActionLimits(now: Clock): ActionLimits {
  const targets = createRateLimiter({ limit: 1, windowMs: MINUTE_MS, now });
  const clients = createRateLimiter({ limit: CLIENT_CALLS_PER_MINUTE, windowMs: MINUTE_MS, now });
  const inFlightTargets = new InFlight();
  const inFlightClients = new InFlight();
  return {
    acquire(key) {
      const target = targets.take(key.targetId, key.targetPerMinute);
      if (!target.allowed) {
        return target;
      }
      const client = clients.take(key.clientId);
      if (!client.allowed) {
        return client;
      }
      if (
        inFlightTargets.count(key.targetId) >= TARGET_IN_FLIGHT ||
        inFlightClients.count(key.clientId) >= CLIENT_IN_FLIGHT
      ) {
        return { allowed: false, retryAfterSeconds: IN_FLIGHT_RETRY_SECONDS };
      }
      const leaveTarget = inFlightTargets.enter(key.targetId);
      const leaveClient = inFlightClients.enter(key.clientId);
      return {
        allowed: true,
        release: () => {
          leaveTarget();
          leaveClient();
        },
      };
    },
  };
}
