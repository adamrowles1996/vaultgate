/**
 * One exec channel (ACT-28): the standard input written and closed, the two
 * output streams collected separately up to the capture limit (ACT-52), the
 * exit status remembered when the server sends one, and the policy timeout
 * turned into a `KILL` on the remote command (ACT-59). The channel is the
 * only thing a call opens on the connection, and it ends with the call.
 */
import { ActionError } from '../../errors.ts';

import { channelFailure } from './failures.ts';

import type { SshDriverChannel } from './driver.ts';
import type { SshCommand, SshResult } from './session.ts';

/**
Bytes from one stream, kept to the limit; anything beyond it is dropped and reported as truncated.
*/
class Capture {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #isTruncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(chunk: Buffer): void {
    const room = this.#limit - this.#bytes;
    if (room <= 0) {
      this.#isTruncated = true;
      return;
    }
    const fitted = chunk.subarray(0, room);
    this.#chunks.push(fitted);
    this.#bytes += fitted.length;
    this.#isTruncated ||= fitted.length < chunk.length;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.#chunks);
  }

  get isTruncated(): boolean {
    return this.#isTruncated;
  }
}

/**
ACT-59: the remote command is signalled, not merely abandoned, when the call runs out of time.
*/
function kill(channel: SshDriverChannel): void {
  try {
    channel.signal('KILL');
  } catch {
    // The channel was already gone; the call ends as `timeout` either way.
  }
}

export function collectChannel(
  channel: SshDriverChannel,
  request: SshCommand,
  signal: AbortSignal,
): Promise<SshResult> {
  return new Promise<SshResult>((resolve, reject) => {
    const abort = (): void => {
      kill(channel);
      reject(new ActionError('timeout'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    const stdout = new Capture(request.captureBytes);
    const stderr = new Capture(request.captureBytes);
    let exitCode: number | null = null;
    signal.addEventListener('abort', abort, { once: true });
    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', abort);
      settle();
    };
    channel.on('data', (chunk) => {
      stdout.add(chunk);
    });
    channel.stderr.on('data', (chunk) => {
      stderr.add(chunk);
    });
    channel.on('exit', (code) => {
      exitCode = typeof code === 'number' ? code : null;
    });
    channel.on('error', (error) => {
      finish(() => {
        reject(channelFailure(error));
      });
    });
    channel.on('close', () => {
      finish(() => {
        resolve({
          exitCode,
          stdout: stdout.bytes,
          stderr: stderr.bytes,
          truncated: stdout.isTruncated || stderr.isTruncated,
        });
      });
    });
    channel.end(request.stdin ?? '');
  });
}
