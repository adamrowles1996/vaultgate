/**
 * A fake of the `ssh2` client and channel the wrapper in
 * `src/actions/connectors/ssh/client.ts` drives (ACT-78), so the real
 * connect, host-key and exec paths are exercised without a server. It keeps
 * its listeners in typed lists rather than extending `EventEmitter`, and the
 * test drives the handshake and the channel through the named methods below.
 */
import type { SshConnectConfig, SshDriverCallback } from '../actions/connectors/ssh/driver.ts';
import type { ExecOptions } from 'ssh2';

type DataListener = (chunk: Buffer) => void;
type ExitListener = (code: number | null) => void;
type PlainListener = () => void;
type ErrorListener = (error: Error) => void;
type ChannelListener = DataListener | ExitListener | PlainListener | ErrorListener;

class FakeStream {
  readonly #listeners: DataListener[] = [];

  on(_event: 'data', listener: DataListener): void {
    this.#listeners.push(listener);
  }

  write(text: string): void {
    for (const listener of this.#listeners) {
      listener(Buffer.from(text, 'utf8'));
    }
  }
}

export class FakeSsh2Channel {
  readonly #data: DataListener[] = [];
  readonly #exit: ExitListener[] = [];
  readonly #close: PlainListener[] = [];
  readonly #error: ErrorListener[] = [];
  readonly stderr = new FakeStream();
  readonly written: string[] = [];
  readonly signals: string[] = [];
  /**
  Makes `signal` throw, as a channel the server has already closed does.
  */
  isBroken = false;

  on(event: 'data', listener: DataListener): void;
  on(event: 'exit', listener: ExitListener): void;
  on(event: 'close', listener: PlainListener): void;
  on(event: 'error', listener: ErrorListener): void;
  on(event: 'data' | 'exit' | 'close' | 'error', listener: ChannelListener): void {
    switch (event) {
      case 'data': {
        this.#data.push(listener as DataListener);
        return;
      }
      case 'exit': {
        this.#exit.push(listener as ExitListener);
        return;
      }
      case 'close': {
        this.#close.push(listener as PlainListener);
        return;
      }
      default: {
        this.#error.push(listener as ErrorListener);
      }
    }
  }

  end(data: string): void {
    this.written.push(data);
  }

  signal(name: string): void {
    this.signals.push(name);
    if (this.isBroken) {
      throw new Error('the channel is already gone');
    }
  }

  write(text: string): void {
    for (const listener of this.#data) {
      listener(Buffer.from(text, 'utf8'));
    }
  }

  exit(code: number | null): void {
    for (const listener of this.#exit) {
      listener(code);
    }
  }

  close(): void {
    for (const listener of this.#close) {
      listener();
    }
  }

  fail(error: Error): void {
    for (const listener of this.#error) {
      listener(error);
    }
  }
}

export interface FakeExec {
  readonly command: string;
  readonly options: ExecOptions;
}

export class FakeSsh2Client {
  readonly #ready: PlainListener[] = [];
  readonly #error: ErrorListener[] = [];
  readonly configs: SshConnectConfig[] = [];
  readonly execs: FakeExec[] = [];
  readonly channel = new FakeSsh2Channel();
  ends = 0;
  /**
  Handed to `exec` instead of a channel, as a server refusing the request does.
  */
  execError: Error | undefined = undefined;

  on(event: 'ready', listener: PlainListener): void;
  on(event: 'error', listener: ErrorListener): void;
  on(event: 'ready' | 'error', listener: PlainListener | ErrorListener): void {
    if (event === 'ready') {
      this.#ready.push(listener as PlainListener);
      return;
    }
    this.#error.push(listener);
  }

  connect(config: SshConnectConfig): void {
    this.configs.push(config);
  }

  exec(command: string, options: ExecOptions, callback: SshDriverCallback): void {
    this.execs.push({ command, options });
    callback(this.execError, this.channel);
  }

  end(): void {
    this.ends += 1;
  }

  ready(): void {
    for (const listener of this.#ready) {
      listener();
    }
  }

  fail(error: Error): void {
    for (const listener of this.#error) {
      listener(error);
    }
  }
}

/**
The configuration the client was connected with; the tests read the verifier and the algorithms off it.
*/
export function connectedWith(client: FakeSsh2Client): SshConnectConfig {
  const [config] = client.configs;
  if (config === undefined) {
    throw new Error('the client was never connected');
  }
  return config;
}

export interface ChannelAnswer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly signalled?: boolean;
}

/**
An exec channel that writes the scripted output and closes with the scripted status.
*/
export function answerChannel(channel: FakeSsh2Channel, answer: ChannelAnswer): void {
  if (answer.stdout !== undefined) {
    channel.write(answer.stdout);
  }
  if (answer.stderr !== undefined) {
    channel.stderr.write(answer.stderr);
  }
  if (answer.signalled === true) {
    channel.exit(null);
  } else if (answer.exitCode !== undefined) {
    channel.exit(answer.exitCode);
  }
  channel.close();
}
