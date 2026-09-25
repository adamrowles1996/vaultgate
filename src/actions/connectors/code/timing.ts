/**
 * Time and background work on the engine's own clock (QG-2). Every wait the
 * code connector bounds — a sidecar exchange outside a call, the health
 * check, a resolution, a build — is a timer the engine schedules, so a test
 * moves it with the manual clock and production uses `setTimeout`. Work the
 * connector starts without awaiting it (a build on save, a deletion) runs
 * through `background`, so a failure is logged and never an unhandled
 * rejection that would end the process.
 */
import type { ConnectorServices } from '../connector.ts';

export type Clock = Pick<ConnectorServices, 'now' | 'schedule'>;

/**
Runs `work` with a signal that aborts after `delayMs`, or when `parent` does.
*/
export async function withDeadline<T>(
  clock: Clock,
  delayMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = clock.schedule(() => {
    controller.abort();
  }, delayMs);
  const signal =
    parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
  try {
    return await work(signal);
  } finally {
    cancel();
  }
}

/**
`wait`'s value, or `'timeout'` at `deadline` (ms since the epoch), whichever comes first.
*/
export async function until<T>(
  clock: Clock,
  wait: Promise<T>,
  deadline: number,
): Promise<T | 'timeout'> {
  const timedOut = Promise.withResolvers<'timeout'>();
  const cancel = clock.schedule(
    () => {
      timedOut.resolve('timeout');
    },
    Math.max(0, deadline - clock.now()),
  );
  try {
    return await Promise.race([wait, timedOut.promise]);
  } finally {
    cancel();
  }
}

/**
Starts `work` without waiting for it; a failure is logged as `what`, never thrown.
*/
export function background(
  services: Pick<ConnectorServices, 'logger'>,
  what: string,
  work: () => Promise<unknown>,
): void {
  void (async () => {
    try {
      await work();
    } catch (error) {
      services.logger.error(
        { error: error instanceof Error ? error.name : 'unknown' },
        `code connector: ${what} failed`,
      );
    }
  })();
}
