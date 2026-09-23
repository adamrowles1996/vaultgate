/**
 * The transport an `ssh` call runs over (ACT-78): one connection, opened
 * after the policy decision, used for one exec channel and closed when the
 * call ends (ACT-28, ACT-58). `client.ts` implements it over `ssh2`;
 * `src/test-support/fake-ssh-client.ts` implements it for the contract
 * tests, so no test needs a server.
 */

/**
 * The credential as the connection uses it, read out of the injected buffers
 * for the length of the call and never held anywhere else (ACT-50).
 */
export type SshAuth =
  | {
      readonly kind: 'key';
      readonly privateKey: string;
      readonly passphrase: string | undefined;
    }
  | { readonly kind: 'password'; readonly password: string };

export interface SshConnection {
  /**
  ACT-55: the host name, kept for the host-key lookup and for nothing else.
  */
  readonly host: string;
  /**
  ACT-55: the address the engine resolved and validated once for this call; the socket goes here.
  */
  readonly address: string;
  readonly port: number;
  readonly username: string;
  /**
  ACT-87: the pinned key, checked against the presented one before authentication.
  */
  readonly hostKey: string;
  readonly auth: SshAuth;
  readonly connectTimeoutMs: number;
  /**
  ACT-59: aborted when the policy timeout elapses; the session kills the channel and closes.
  */
  readonly signal: AbortSignal;
}

export interface SshCommand {
  readonly command: string;
  /**
  Written to the command's standard input, which is closed straight after (ACT-27).
  */
  readonly stdin: string | undefined;
  /**
  ACT-52: each of the two streams is collected up to this many bytes, `max_output_bytes` plus the guard band.
  */
  readonly captureBytes: number;
}

export interface SshResult {
  /**
  ACT-27: `null` when the channel closed without one (the command was signalled).
  */
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /**
  True when either stream was longer than `captureBytes`; the engine cuts again at the limit itself.
  */
  readonly truncated: boolean;
}

export interface SshSession {
  exec(request: SshCommand): Promise<SshResult>;
  close(): void;
}

export type SshSessionFactory = (connection: SshConnection) => Promise<SshSession>;
