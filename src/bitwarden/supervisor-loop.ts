/**
 * The supervisor's restart loop (VAULT-6): start the current generation,
 * serve until the child exits, count consecutive failures, back off, repeat;
 * idle at once while no generation is configured (VAULT-18). The supervisor
 * owns the state the loop reports into and decides when the loop is halted.
 */
import { backoffMs, MIN_HEALTHY_UPTIME_MS } from './supervisor-support.ts';

import type { Clock } from './clock.ts';
import type { ServeHandle } from './serve-process.ts';
import type { Generation, GenerationStarter } from './supervisor-start.ts';
import type { Logger } from '../logger.ts';

export interface LoopDependencies {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly starter: GenerationStarter;
  readonly pause: (delayMs: number) => Promise<void>;
  readonly isHalted: () => boolean;
  readonly generation: () => Generation | undefined;
  /**
  `bw serve` is unlocked: readiness and the sync schedule start.
  */
  readonly onReady: () => void;
  /**
  The child is gone, whatever the reason: readiness and the sync schedule stop.
  */
  readonly onExit: () => void;
}

const ERROR_LEVEL_AFTER_FAILURES = 10;

export class RestartLoop {
  readonly #dependencies: LoopDependencies;
  #failures = 0;

  constructor(dependencies: LoopDependencies) {
    this.#dependencies = dependencies;
  }

  /**
  Serves until the child exits; `true` when that was our own halt. A child that
  was ready for `MIN_HEALTHY_UPTIME_MS` clears the failure count; an earlier exit
  counts as one more consecutive failure (VAULT-6).
  */
  async #serveUntilExit(serve: ServeHandle): Promise<boolean> {
    const { clock, logger, onReady, onExit, isHalted } = this.#dependencies;
    const readyAt = clock.now();
    logger.info('vault ready');
    onReady();
    const exit = await serve.exited;
    onExit();
    if (isHalted()) {
      return true;
    }
    const uptimeMs = clock.now() - readyAt;
    if (uptimeMs >= MIN_HEALTHY_UPTIME_MS) {
      this.#failures = 0;
    }
    logger.warn({ ...exit, uptimeMs, output: serve.output() }, 'bw serve exited');
    return false;
  }

  /**
  Exponential backoff between attempts; error level once a minute after ten failures (VAULT-6).
  */
  async #recordFailure(error: Error): Promise<void> {
    const { logger, pause, isHalted } = this.#dependencies;
    if (isHalted()) {
      return;
    }
    this.#failures += 1;
    const delayMs = backoffMs(this.#failures);
    const fields = { err: error, attempt: this.#failures, nextRetryMs: delayMs };
    if (this.#failures >= ERROR_LEVEL_AFTER_FAILURES) {
      logger.error(fields, 'vault backend unavailable');
    } else {
      logger.warn(fields, 'vault backend start failed');
    }
    await pause(delayMs);
  }

  /**
  A new generation starts its count afresh (VAULT-18).
  */
  resetFailures(): void {
    this.#failures = 0;
  }

  /**
  Runs until halted, or at once when nothing is configured; `initial` is a child already unlocked.
  */
  async run(initial?: ServeHandle): Promise<void> {
    const { starter, logger, isHalted, generation } = this.#dependencies;
    let serve = initial;
    while (!isHalted()) {
      if (serve === undefined) {
        const current = generation();
        if (current === undefined) {
          return;
        }
        const attempt = await starter.start(current);
        if (!attempt.ok && attempt.error.name === 'VersionRefusedError') {
          logger.error({ err: attempt.error }, 'bitwarden cli refused');
          return;
        }
        if (!attempt.ok) {
          await this.#recordFailure(attempt.error);
          continue;
        }
        serve = attempt.value;
      }
      if (await this.#serveUntilExit(serve)) {
        return;
      }
      serve = undefined;
      await this.#recordFailure(new Error('bw serve exited'));
    }
  }
}
