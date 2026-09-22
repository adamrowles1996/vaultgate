import { PassThrough } from 'node:stream';

import type { ChildLike, ExitListener, SpawnFunction } from '../bitwarden/serve-process.ts';

type ErrorListener = (error: Error) => void;

/**
 * A stand-in for `ChildProcess`: the test writes its output and decides when
 * and how it ends. As with a real child, `exit`, `close` and `error` are
 * emitted on a later turn, so a script may end the child before the caller
 * has attached its listeners. A signal ends the child unless the test has
 * told it to `ignore` that signal.
 */
export class FakeChild implements ChildLike {
  readonly #exitListeners: ExitListener[] = [];
  readonly #closeListeners: ExitListener[] = [];
  readonly #errorListeners: ErrorListener[] = [];
  readonly #ignoredSignals = new Set<NodeJS.Signals>();
  #ended = false;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  once(event: 'close' | 'exit', listener: ExitListener): this;
  once(event: 'error', listener: ErrorListener): this;
  once(event: 'close' | 'exit' | 'error', listener: ExitListener | ErrorListener): this {
    if (event === 'error') {
      this.#errorListeners.push(listener as ErrorListener);
    } else {
      (event === 'exit' ? this.#exitListeners : this.#closeListeners).push(
        listener as ExitListener,
      );
    }
    return this;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (!this.#ignoredSignals.has(signal)) {
      this.exit(null, signal);
    }
    return true;
  }

  /**
  Makes the child survive `signal`, as a wedged process does, so escalation can be tested.
  */
  ignore(signal: NodeJS.Signals): void {
    this.#ignoredSignals.add(signal);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      for (const listener of this.#exitListeners.splice(0)) {
        listener(code, signal);
      }
      for (const listener of this.#closeListeners.splice(0)) {
        listener(code, signal);
      }
    });
  }

  fail(error: Error): void {
    this.#ended = true;
    setImmediate(() => {
      for (const listener of this.#errorListeners.splice(0)) {
        listener(error);
      }
    });
  }

  /**
  Writes to stdout and exits with `code`: the shape of every one-shot CLI command.
  */
  finish(stdout: string, code = 0): void {
    this.stdout.write(stdout);
    this.exit(code);
  }
}

export interface SpawnRecord {
  readonly command: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly child: FakeChild;
}

export type ChildScript = (record: SpawnRecord) => void;

/**
 * A `SpawnFunction` that records every call and hands each child to the
 * script keyed by its first argument (`--version`, `status`, `serve`, …).
 * An unscripted child simply runs until it is signalled.
 */
export class FakeSpawner {
  readonly #scripts = new Map<string, ChildScript>();
  readonly records: SpawnRecord[] = [];

  readonly spawn: SpawnFunction = (command, argv, environment) => {
    const child = new FakeChild();
    const record = { command, argv, environment, child };
    this.records.push(record);
    this.#scripts.get(argv[0] ?? '')?.(record);
    return child;
  };

  constructor(scripts: Readonly<Record<string, ChildScript>> = {}) {
    for (const [name, script] of Object.entries(scripts)) {
      this.#scripts.set(name, script);
    }
  }

  on(subcommand: string, script: ChildScript): this {
    this.#scripts.set(subcommand, script);
    return this;
  }

  spawned(subcommand: string): SpawnRecord[] {
    return this.records.filter((record) => record.argv[0] === subcommand);
  }
}
