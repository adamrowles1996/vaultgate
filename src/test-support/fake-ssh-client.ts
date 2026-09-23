/**
 * What the `ssh` connector's contract tests run against (ACT-75, ACT-78): a
 * scripted `SshSession` that reproduces the order the real client works in —
 * the host key is checked during the handshake, so a mismatch happens before
 * the credential is ever offered (ACT-87) — records every connection and
 * command, and can fail, hang or echo the credential back the way a hostile
 * server would (ACT-53).
 */
import { isPinnedHostKey } from '../actions/connectors/ssh/host-key.ts';
import { ActionError } from '../actions/errors.ts';

import type {
  SshCommand,
  SshConnection,
  SshResult,
  SshSession,
  SshSessionFactory,
} from '../actions/connectors/ssh/session.ts';

/**
An `ssh-ed25519` public key line, and a second one for the server that presents the wrong key.
*/
export const HOST_KEYS = {
  pinned:
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWZha2UtcGlubmVkLWhvc3Qta2V5LTAwMDAwMDAwMDAwMA== fixture',
  other:
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWZha2Utb3RoZXItaG9zdC1rZXktMDAwMDAwMDAwMDAwMA== fixture',
  /**
  The pinned key written the other way round (ACT-87): its SHA-256 fingerprint.
  */
  fingerprint: 'SHA256:my2PfowifNlB0Rm27QzEE1lx/6QJUNbA5SOZx4XWoFM',
} as const;

export function hostKeyBlob(line: string): Buffer {
  return Buffer.from(line.split(' ', 2)[1] ?? '', 'base64');
}

export type Answer = Partial<SshResult> | Error | 'hang';

export interface FakeSshOptions {
  /**
  What each command is answered with, in order; the last answer repeats.
  */
  readonly answers?: readonly Answer[];
  /**
  The key the server presents; the pinned one unless a test says otherwise.
  */
  readonly presents?: string;
  /**
  The server rejects whatever credential it is offered (ACT-87 ordering assertions use both).
  */
  readonly authFails?: boolean;
  /**
  Thrown instead of connecting, so the connect-failure paths can be driven.
  */
  readonly openError?: Error;
  readonly closeError?: Error;
}

export interface FakeSsh {
  readonly open: SshSessionFactory;
  /**
  Every connection the connector asked for, in order; a mismatch test asserts this stays empty.
  */
  readonly opened: SshConnection[];
  /**
  The credential of every connection that reached authentication (ACT-87: none on a mismatch).
  */
  readonly offered: string[];
  readonly commands: SshCommand[];
  readonly closed: number[];
  readonly killed: number[];
}

const EMPTY: SshResult = {
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  truncated: false,
};

function untilAborted(signal: AbortSignal, killed: number[]): Promise<never> {
  return new Promise((_resolve, reject) => {
    const stop = (): void => {
      killed.push(killed.length + 1);
      reject(new ActionError('timeout'));
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
  });
}

function credentialOf(connection: SshConnection): string {
  const { auth } = connection;
  return auth.kind === 'key' ? auth.privateKey : auth.password;
}

export function fakeSshClient(options: FakeSshOptions = {}): FakeSsh {
  const opened: SshConnection[] = [];
  const offered: string[] = [];
  const commands: SshCommand[] = [];
  const closed: number[] = [];
  const killed: number[] = [];
  const answers =
    options.answers === undefined || options.answers.length === 0 ? [{}] : options.answers;
  const session = (connection: SshConnection): SshSession => ({
    exec(request) {
      commands.push(request);
      const answer = answers.at(Math.min(commands.length - 1, answers.length - 1)) ?? 'hang';
      if (answer === 'hang') {
        return untilAborted(connection.signal, killed);
      }
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ ...EMPTY, ...answer });
    },
    close() {
      closed.push(opened.length);
      if (options.closeError !== undefined) {
        throw options.closeError;
      }
    },
  });
  const open: SshSessionFactory = (connection) => {
    if (options.openError !== undefined) {
      return Promise.reject(options.openError);
    }
    opened.push(connection);
    // The real client verifies the host key during the key exchange, so a
    // mismatch stops the handshake before any authentication method is sent.
    if (!isPinnedHostKey(connection.hostKey, hostKeyBlob(options.presents ?? HOST_KEYS.pinned))) {
      return Promise.reject(new ActionError('host_key_mismatch'));
    }
    offered.push(credentialOf(connection));
    return options.authFails === true
      ? Promise.reject(new ActionError('authentication_failed'))
      : Promise.resolve(session(connection));
  };
  return { open, opened, offered, commands, closed, killed };
}
