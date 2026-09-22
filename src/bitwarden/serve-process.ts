/**
 * The one module that spawns processes (ARCH-2, VAULT-1). It knows how to run
 * the Bitwarden CLI for the four commands vaultgate needs and how to keep a
 * `bw serve` child alive and stop it cleanly (VAULT-7). Everything is driven
 * by an injected `spawn` and `Clock` so the behaviour is unit-tested with a
 * fake child.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { fail, ok, type Result } from '../result.ts';

import { type Clock, sleep } from './clock.ts';
import { statusTemplateSchema, type StatusTemplate } from './types.ts';
import {
  compareVersions,
  formatVersion,
  MINIMUM_BW_VERSION,
  parseVersion,
  type SemanticVersion,
} from './versions.ts';

import type { Credentials } from './credentials.ts';
import type { Environment } from '../config/index.ts';
import type { Readable } from 'node:stream';

export type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/**
The slice of `ChildProcess` the supervisor relies on; a fake implements it in tests.
*/
export interface ChildLike {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close' | 'exit', listener: ExitListener): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export type SpawnFunction = (
  command: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
) => ChildLike;

export const spawnChild: SpawnFunction = (command, argv, environment) =>
  spawn(command, argv, {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

const INHERITED_VARIABLES = ['PATH', 'HOME', 'TMPDIR'] as const;
const COMMAND_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5000;

/**
A CLI invocation always names its command or flag first.
*/
type CommandArguments = readonly [string, ...string[]];

export interface CommandOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServeHandle {
  readonly endpoint: string;
  /**
  Settles when the child has exited, however that happened.
  */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /**
  `SIGTERM`, then `SIGKILL` after five seconds (VAULT-7).
  */
  stop(): Promise<void>;
}

export interface BwCliOptions {
  readonly bin: string;
  readonly dataDir: string;
  /**
  The parent process environment; only `PATH`, `HOME` and `TMPDIR` are passed on.
  */
  readonly environment: Environment;
  readonly spawn: SpawnFunction;
  readonly clock: Clock;
}

function collect(stream: Readable | null, into: string[]): void {
  stream?.on('data', (chunk: Buffer | string) => {
    into.push(chunk.toString());
  });
}

export class BwCli {
  readonly #options: BwCliOptions;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #inFlight = new Set<ChildLike>();

  constructor(options: BwCliOptions) {
    this.#options = options;
    const inherited: Record<string, string> = {};
    for (const name of INHERITED_VARIABLES) {
      const value = options.environment[name];
      if (value !== undefined) {
        inherited[name] = value;
      }
    }
    this.#environment = {
      ...inherited,
      BITWARDENCLI_APPDATA_DIR: join(options.dataDir, 'bw'),
      BW_NOINTERACTION: 'true',
    };
  }

  /**
  Runs one CLI command to completion; a spawn failure or timeout is an `Error`.
  */
  #run(
    argv: CommandArguments,
    extraEnvironment: Readonly<Record<string, string>> = {},
  ): Promise<Result<CommandOutcome>> {
    const { promise, resolve } = Promise.withResolvers<Result<CommandOutcome>>();
    const child = this.#options.spawn(this.#options.bin, argv, {
      ...this.#environment,
      ...extraEnvironment,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    this.#inFlight.add(child);
    const timeout = sleep(this.#options.clock, COMMAND_TIMEOUT_MS);
    child.once('error', (error) => {
      timeout.cancel();
      this.#inFlight.delete(child);
      resolve(fail(error));
    });
    child.once('close', (code) => {
      timeout.cancel();
      this.#inFlight.delete(child);
      resolve(ok({ code, stdout: stdout.join(''), stderr: stderr.join('') }));
    });
    void timeout.done.then((outcome) => {
      if (outcome !== 'elapsed') {
        return;
      }

      child.kill('SIGKILL');
      resolve(fail(new Error(`bw ${argv[0]} did not finish within ${COMMAND_TIMEOUT_MS} ms`)));
    });
    return promise;
  }

  async #expectSuccess(
    argv: CommandArguments,
    extraEnvironment?: Readonly<Record<string, string>>,
  ): Promise<Result<CommandOutcome>> {
    const outcome = await this.#run(argv, extraEnvironment);
    if (!outcome.ok) {
      return outcome;
    }
    return outcome.value.code === 0
      ? outcome
      : fail(new Error(`bw ${argv[0]} exited with status ${outcome.value.code ?? 'null'}`));
  }

  /**
  Kills every one-shot command still running, so a shutdown never waits on the CLI.
  */
  abort(): void {
    for (const child of this.#inFlight) {
      child.kill('SIGKILL');
    }
  }

  /**
  `bw --version`, refusing anything below `MINIMUM_BW_VERSION` (VAULT-2).
  */
  async version(): Promise<Result<SemanticVersion>> {
    const outcome = await this.#expectSuccess(['--version']);
    if (!outcome.ok) {
      return outcome;
    }
    const version = parseVersion(outcome.value.stdout);
    if (version === undefined) {
      return fail(new Error('bw --version printed no recognisable version'));
    }
    const minimum = parseVersion(MINIMUM_BW_VERSION);
    return minimum !== undefined && compareVersions(version, minimum) < 0
      ? fail(
          new VersionRefusedError(
            `bw ${formatVersion(version)} is older than the minimum ${MINIMUM_BW_VERSION}`,
          ),
        )
      : ok(version);
  }

  /**
  `bw config server <url>` (VAULT-3); only valid while logged out.
  */
  async configureServer(url: string): Promise<Result<void>> {
    const outcome = await this.#expectSuccess(['config', 'server', url]);
    return outcome.ok ? ok(undefined) : outcome;
  }

  /**
  `bw status` as the CLI reports it before any `bw serve` exists.
  */
  async status(): Promise<Result<StatusTemplate>> {
    const outcome = await this.#expectSuccess(['status']);
    if (!outcome.ok) {
      return outcome;
    }
    const parsed = statusTemplateSchema.safeParse(parseJson(outcome.value.stdout));
    return parsed.success ? ok(parsed.data) : fail(new Error('bw status printed no status JSON'));
  }

  /**
  `bw login --apikey` with the key in the child environment only (VAULT-4).
  */
  async login(credentials: Credentials): Promise<Result<void>> {
    const outcome = await this.#expectSuccess(['login', '--apikey'], {
      BW_CLIENTID: credentials.clientId,
      BW_CLIENTSECRET: credentials.clientSecret(),
    });
    return outcome.ok ? ok(undefined) : outcome;
  }

  /**
  Starts `bw serve` on loopback (VAULT-1). Spawn failures surface through `exited`.
  */
  serve(port: number): ServeHandle {
    const child = this.#options.spawn(
      this.#options.bin,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      this.#environment,
    );
    child.stdout?.resume();
    child.stderr?.resume();
    const { promise: exited, resolve } = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
    child.once('error', () => {
      resolve({ code: null, signal: null });
    });
    const clock = this.#options.clock;
    return {
      endpoint: `http://127.0.0.1:${port}`,
      exited,
      stop: async () => {
        child.kill('SIGTERM');
        const grace = sleep(clock, STOP_GRACE_MS);
        const first = await Promise.race([settled(exited), grace.done]);
        grace.cancel();
        if (first !== 'elapsed') {
          return;
        }

        child.kill('SIGKILL');
        await exited;
      },
    };
  }
}

async function settled(exited: Promise<unknown>): Promise<'exited'> {
  await exited;
  return 'exited';
}

export class VersionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionRefusedError';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
