/**
 * Time as an injected dependency (QG-2): the backend never reads the wall
 * clock or global timers directly, so tests drive every delay themselves.
 */
export interface Clock {
  now(): number;
  /**
  Runs `callback` after `delayMs`; the returned function cancels it.
  */
  schedule(callback: () => void, delayMs: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

type SleepOutcome = 'elapsed' | 'cancelled';

export interface Sleep {
  readonly done: Promise<SleepOutcome>;
  readonly cancel: () => void;
}

/**
A promise that settles after `delayMs`; `cancel` settles it early.
*/
export function sleep(clock: Clock, delayMs: number): Sleep {
  const { promise: done, resolve: wake } = Promise.withResolvers<SleepOutcome>();
  const cancelTimer = clock.schedule(() => {
    wake('elapsed');
  }, delayMs);
  return {
    done,
    cancel: () => {
      cancelTimer();
      wake('cancelled');
    },
  };
}
