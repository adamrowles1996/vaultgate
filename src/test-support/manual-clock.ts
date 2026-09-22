import { setImmediate as flushMacrotask } from 'node:timers/promises';

import type { Clock } from '../bitwarden/clock.ts';

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

/**
 * A `Clock` that only moves when a test says so (QG-2). `advance` fires
 * timers in due order and yields to the event loop after each one so promise
 * chains waiting on them make progress before the next fires.
 */
export class ManualClock implements Clock {
  #now: number;
  #nextId = 1;
  readonly #timers: Timer[] = [];

  constructor(start = Date.UTC(2026, 8, 22, 12, 0, 0)) {
    this.#now = start;
  }

  #dueTimer(until: number): Timer | undefined {
    const due = this.#timers.filter((timer) => timer.at <= until);
    due.sort((left, right) => left.at - right.at || left.id - right.id);
    return due[0];
  }

  now(): number {
    return this.#now;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer = { id: this.#nextId++, at: this.#now + delayMs, callback };
    this.#timers.push(timer);
    return () => {
      const index = this.#timers.indexOf(timer);
      if (index !== -1) {
        this.#timers.splice(index, 1);
      }
    };
  }

  pending(): number {
    return this.#timers.length;
  }

  /**
  Lets every already-settled promise chain run without moving time.
  */
  async settle(): Promise<void> {
    await flushMacrotask();
    await flushMacrotask();
  }

  /**
  Moves time forward by `ms`, firing every timer that falls due along the way.
  */
  async advance(ms: number): Promise<void> {
    const until = this.#now + ms;
    await this.settle();
    for (let timer = this.#dueTimer(until); timer !== undefined; timer = this.#dueTimer(until)) {
      this.#timers.splice(this.#timers.indexOf(timer), 1);
      this.#now = Math.max(this.#now, timer.at);
      timer.callback();
      await this.settle();
    }
    this.#now = until;
    await this.settle();
  }
}
