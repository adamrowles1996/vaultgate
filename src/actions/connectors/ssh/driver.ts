/**
 * The shape of `ssh2` this connector uses (ACT-78, ACT-87): the handful of
 * client and channel members `client.ts` and `channel.ts` touch, and the
 * connection configuration the library is given. Everything vaultgate
 * refuses to use — a pseudo-terminal, agent forwarding, X11, an environment,
 * port forwarding, keyboard-interactive authentication — is absent from the
 * configuration built here rather than merely unused (ACT-28). The `ssh2`
 * types are imported for their own sake; the runtime is loaded only when a
 * call runs (ACT-73).
 */
import { isPinnedHostKey } from './host-key.ts';

import type { SshConnection } from './session.ts';
import type { ConnectConfig, ExecOptions } from 'ssh2';

/**
 * ACT-87: the library's modern defaults with `ssh-rsa` removed, so a server
 * offering only the SHA-1 signature algorithm cannot be reached. What
 * remains for `serverHostKey` is `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`
 * and `rsa-sha2-512`/`rsa-sha2-256`. `cipher` (`chacha20-poly1305@openssh.com`,
 * the AES-GCM and AES-CTR suites) and `kex` (`curve25519-sha256`, the ECDH
 * suites, `diffie-hellman-group14-sha256` and above) keep the library's
 * defaults, which carry nothing older.
 */
const ALGORITHMS: NonNullable<ConnectConfig['algorithms']> = {
  serverHostKey: { append: [], prepend: [], remove: ['ssh-rsa'] },
};

/**
ACT-28: one exec channel, no pseudo-terminal, no X11, no environment of vaultgate's making.
*/
export const EXEC_OPTIONS: ExecOptions = { pty: false, x11: false, env: {} };

export interface SshDriverStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export interface SshDriverChannel {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  readonly stderr: SshDriverStream;
  /**
  Writes the standard input and closes it; an empty string closes it with nothing written (ACT-27).
  */
  end(data: string): unknown;
  signal(name: string): unknown;
}

/**
 * `ssh2`'s connection configuration with the one member this connector needs
 * to keep hold of narrowed to the form it uses: a synchronous host verifier
 * over the raw key. The library's own type is a union of four verifier
 * shapes, which nothing could call.
 */
export interface SshConnectConfig extends Omit<ConnectConfig, 'hostVerifier'> {
  readonly hostVerifier: (key: Buffer) => boolean;
}

export type SshDriverCallback = (error: Error | undefined, channel: SshDriverChannel) => void;

export interface SshDriverClient {
  on(event: 'ready', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  connect(config: SshConnectConfig): unknown;
  exec(command: string, options: ExecOptions, callback: SshDriverCallback): unknown;
  end(): unknown;
}

export type SshDriver = () => SshDriverClient;

/**
 * ACT-55: the socket goes to the address the engine validated, and the host
 * name is used for the host-key lookup only. ACT-87: the presented key is
 * checked in `hostVerifier`, which `ssh2` calls during the key exchange,
 * before any authentication method is offered. Only the one method the
 * target's mapping names is offered, so no agent, keyboard-interactive or
 * `none` attempt can happen behind it.
 */
export function connectConfigOf(
  connection: SshConnection,
  onMismatch: () => void,
): SshConnectConfig {
  const { auth } = connection;
  return {
    host: connection.address,
    port: connection.port,
    username: connection.username,
    readyTimeout: connection.connectTimeoutMs,
    algorithms: ALGORITHMS,
    agentForward: false,
    tryKeyboard: false,
    authHandler: [auth.kind === 'key' ? 'publickey' : 'password'],
    hostVerifier: (key: Buffer): boolean => {
      const isPinned = isPinnedHostKey(connection.hostKey, key);
      if (!isPinned) {
        onMismatch();
      }
      return isPinned;
    },
    ...(auth.kind === 'key'
      ? {
          privateKey: auth.privateKey,
          ...(auth.passphrase !== undefined && { passphrase: auth.passphrase }),
        }
      : { password: auth.password }),
  };
}
