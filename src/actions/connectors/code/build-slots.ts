/**
 * How many builds run at once (ACT-108, T46). Each build downloads up to
 * `max_archive_bytes` and has the sidecar extract up to `max_total_bytes`,
 * so at most `total` run across every code target, and at most `perTarget`
 * of them are builds that calls started for a ref they named (a branch, a
 * tag, a SHA or `pr:<n>`). Such a build is refused past either cap, so an
 * agent naming ref after ref cannot fill the sidecar's disk and threads or
 * spend the token's rate limit; the call answers `rate_limited`. Every other
 * build (a save, Rebuild index, the configured ref a call needs or found
 * moved) waits for a slot, in order, and is never refused.
 */

export interface BuildLimits {
  /**
  Builds running at once across every code target.
  */
  readonly total: number;
  /**
  Builds of refs that calls named, running at once for one target.
  */
  readonly perTarget: number;
}

export const BUILD_LIMITS: BuildLimits = { total: 4, perTarget: 2 };

/**
What a refused call is told to wait before it asks again (`detail.retry_after_s`).
*/
export const BUILD_RETRY_AFTER_S = 30;

/**
Gives the slot back; a second call does nothing.
*/
export type Release = () => void;

export interface BuildSlots {
  /**
  A slot for a build of a ref a call named, or `undefined` when the target or the process is at its cap.
  */
  tryTake(targetId: string): Release | undefined;
  /**
  A slot for any other build, as soon as one is free; the builds waiting take them in order.
  */
  take(): Promise<Release>;
}

export function createBuildSlots(limits: BuildLimits = BUILD_LIMITS): BuildSlots {
  let running = 0;
  const named = new Map<string, number>();
  const waiting: (() => void)[] = [];

  function count(targetId: string, delta: number): void {
    const now = (named.get(targetId) ?? 0) + delta;
    if (now === 0) {
      named.delete(targetId);
    } else {
      named.set(targetId, now);
    }
  }

  function releaser(targetId?: string): Release {
    let isReleased = false;
    return () => {
      if (isReleased) {
        return;
      }
      isReleased = true;
      if (targetId !== undefined) {
        count(targetId, -1);
      }
      // A build waiting takes the slot over; otherwise it is free again.
      const next = waiting.shift();
      if (next === undefined) {
        running -= 1;
      } else {
        next();
      }
    };
  }

  return {
    tryTake(targetId) {
      const mine = named.get(targetId) ?? 0;
      if (running >= limits.total || mine >= limits.perTarget) {
        return;
      }
      running += 1;
      count(targetId, 1);
      return releaser(targetId);
    },
    take() {
      if (running < limits.total) {
        running += 1;
        return Promise.resolve(releaser());
      }
      const { promise, resolve } = Promise.withResolvers<Release>();
      waiting.push(() => {
        resolve(releaser());
      });
      return promise;
    },
  };
}
