import { describe, expect, it } from 'vitest';

import { captureLogger } from '../test-support/logging.ts';
import { LISTEN } from '../test-support/relay-fixtures.ts';

import { type ListeningServer, startRelayListener } from './listener.ts';

class FakeServer implements ListeningServer {
  readonly #errors: ((error: Error) => void)[] = [];
  readonly #listening: (() => void)[] = [];
  readonly binds: [number, string][] = [];
  closes = 0;

  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'listening', listener: () => void): this;
  on(event: 'error' | 'listening', listener: ((error: Error) => void) | (() => void)): this {
    if (event === 'error') {
      this.#errors.push(listener);
    } else {
      this.#listening.push(listener as () => void);
    }
    return this;
  }

  fail(error: Error): void {
    for (const listener of this.#errors) {
      listener(error);
    }
  }

  listening(): void {
    for (const listener of this.#listening) {
      listener();
    }
  }

  listen(port: number, host: string): this {
    this.binds.push([port, host]);
    return this;
  }

  close(): this {
    this.closes += 1;
    return this;
  }
}

interface Scheduled {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

function harness(): {
  server: FakeServer;
  scheduled: Scheduled[];
  lines: () => readonly Record<string, unknown>[];
  start: () => ReturnType<typeof startRelayListener>;
} {
  const server = new FakeServer();
  const scheduled: Scheduled[] = [];
  const { logger, lines } = captureLogger();
  return {
    server,
    scheduled,
    lines,
    start: () =>
      startRelayListener({
        server,
        listen: LISTEN,
        logger,
        retryMs: 10_000,
        schedule: (callback, delayMs) => {
          const entry = { callback, delayMs, cancelled: false };
          scheduled.push(entry);
          return () => {
            entry.cancelled = true;
          };
        },
      }),
  };
}

describe('startRelayListener', () => {
  it('RELAY-2 binds the configured address and reports when it listens', () => {
    const { server, lines, start } = harness();
    start();
    expect(server.binds).toStrictEqual([[8087, '100.64.0.10']]);
    server.listening();
    expect(lines().at(-1)?.['msg']).toBe('credential relay listening');
  });

  it('RELAY-2 retries a failed bind instead of ending the process', () => {
    const { server, scheduled, lines, start } = harness();
    start();
    server.fail(Object.assign(new Error('bind'), { code: 'EADDRNOTAVAIL' }));
    expect(scheduled.map((entry) => entry.delayMs)).toStrictEqual([10_000]);
    expect(lines().at(-1)?.['msg']).toBe('credential relay could not listen; retrying');
    scheduled[0]?.callback();
    expect(server.binds).toHaveLength(2);
  });

  it('RELAY-2 stops retrying once closed', () => {
    const { server, scheduled, start } = harness();
    const listener = start();
    server.fail(new Error('bind'));
    listener.close();
    expect(scheduled[0]?.cancelled).toBe(true);
    expect(server.closes).toBe(1);
    server.fail(new Error('late'));
    expect(scheduled).toHaveLength(1);
    const unscheduled = harness();
    unscheduled.start().close();
    expect(unscheduled.server.closes).toBe(1);
  });
});
