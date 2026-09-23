/**
 * The SSH session over `ssh2` (ACT-87): one client per call, connected to the
 * pinned address with the host name kept for the host-key lookup (ACT-55),
 * the presented key checked against the pinned one during the key exchange
 * and before any authentication method is offered, one exec channel per call
 * and the connection ended when the call ends (ACT-28, ACT-58). The library
 * is loaded through a dynamic import, so a deployment that never enables
 * `ssh` never loads it (ACT-73).
 */
import { ActionError } from '../../errors.ts';

import { collectChannel } from './channel.ts';
import { connectConfigOf, EXEC_OPTIONS, type SshDriver, type SshDriverClient } from './driver.ts';
import { connectFailure } from './failures.ts';

import type { SshCommand, SshConnection, SshResult, SshSession } from './session.ts';

function openChannel(
  client: SshDriverClient,
  request: SshCommand,
  signal: AbortSignal,
): Promise<SshResult> {
  return new Promise<SshResult>((resolve, reject) => {
    client.exec(request.command, EXEC_OPTIONS, (error, channel) => {
      if (error === undefined) {
        resolve(collectChannel(channel, request, signal));
        return;
      }
      reject(new ActionError('upstream_error', { message: error.message }));
    });
  });
}

function createSession(client: SshDriverClient, connection: SshConnection): SshSession {
  return {
    exec: (request) => openChannel(client, request, connection.signal),
    close: () => {
      client.end();
    },
  };
}

/**
 * ACT-87: a key that is not the pinned one fails the call with
 * `host_key_mismatch`, and because `ssh2` calls the verifier during the key
 * exchange the credential is never offered. The library reports the refusal
 * as a handshake error, so the mismatch is remembered and answered as itself.
 */
export function openSshSession(create: SshDriver, connection: SshConnection): Promise<SshSession> {
  return new Promise<SshSession>((resolve, reject) => {
    const client = create();
    let isMismatch = false;
    client.on('ready', () => {
      resolve(createSession(client, connection));
    });
    client.on('error', (error) => {
      reject(isMismatch ? new ActionError('host_key_mismatch') : connectFailure(error));
      client.end();
    });
    client.connect(
      connectConfigOf(connection, () => {
        isMismatch = true;
      }),
    );
  });
}

/**
ACT-73: `ssh2` is reached only from here, and only when an `ssh` call actually runs.
*/
export async function loadSshDriver(): Promise<SshDriver> {
  const { Client } = await import('ssh2');
  return () => new Client();
}

export async function sshSession(
  connection: SshConnection,
  load: () => Promise<SshDriver> = loadSshDriver,
): Promise<SshSession> {
  return openSshSession(await load(), connection);
}
