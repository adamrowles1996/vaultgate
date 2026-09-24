/**
 * The transport one `winrm_run` runs over (ACT-78): one WS-Management shell
 * per call, created after the policy decision, used for one command and
 * deleted when the call ends (ACT-28, ACT-58). `client.ts` implements it over
 * the pinned HTTPS transport; `src/test-support/fake-wsman.ts` implements the
 * destination side for the contract tests, so no test needs a Windows host.
 */
import type { WinrmShell } from './envelopes.ts';
import type { WinrmAuth } from './schemas.ts';
import type { PinnedFetch } from '../../../net/pinned-https.ts';

/**
 * What `client.ts` is built over; injected so a contract test drives the
 * whole connector — the WS-Management exchanges and, on a `negotiate` target,
 * a real NTLM handshake — without a socket or a Windows host.
 */
export interface WinrmDependencies {
  readonly transport: PinnedFetch;
  /**
  Sent as `User-Agent: vaultgate/<version>`, as the `http` connector does.
  */
  readonly version: string;
  /**
  The `wsa:MessageID` of each exchange; injected so a test can assert the exact envelopes.
  */
  readonly newId: () => string;
  /**
  ACT-90: the deadline for `Signal` and `Delete`, which run after the call's own deadline elapsed.
  */
  readonly cleanupSignal: () => AbortSignal;
  /**
  ACT-89: the NTLM client challenge and exported session key; never anything an agent chooses.
  */
  readonly random: (bytes: number) => Buffer;
  /**
  ACT-89: the NTLMv2 blob's timestamp, for a destination whose challenge carries none.
  */
  readonly now: () => number;
}

export interface WinrmConnection {
  /**
  The endpoint as the operator wrote it (`https://host:5986/wsman`); it names the TLS server and `wsa:To`.
  */
  readonly url: string;
  /**
  ACT-55: the address the engine resolved and validated once for this call; the socket goes here.
  */
  readonly address: string;
  readonly username: string;
  readonly password: string;
  /**
  ACT-89: `negotiate` runs NTLM and seals the payload; `basic` sends the pair, and only over TLS.
  */
  readonly auth: WinrmAuth;
  readonly shell: WinrmShell;
  /**
  ACT-57: the pinned leaf certificate, lower-case hex, or `undefined` to let the system store verify.
  */
  readonly certificateSha256: string | undefined;
  /**
  ACT-59: aborted when the policy timeout elapses; the session terminates the command and deletes the shell.
  */
  readonly signal: AbortSignal;
}

export interface WinrmCommand {
  readonly command: string;
  /**
  Written to the command's standard input with `End="true"`, which closes it (ACT-27).
  */
  readonly stdin: string | undefined;
  /**
  ACT-52: each stream is collected up to this many bytes, `max_output_bytes` plus the guard band.
  */
  readonly captureBytes: number;
}

export interface WinrmResult {
  /**
  ACT-27: `null` when the shell ended without one (the command was signalled).
  */
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly truncated: boolean;
}

export interface WinrmSession {
  run(request: WinrmCommand): Promise<WinrmResult>;
  /**
  ACT-58: deletes the shell; it runs on its own deadline, because the call's may already have elapsed.
  */
  close(): Promise<void>;
}

export type WinrmSessionFactory = (connection: WinrmConnection) => Promise<WinrmSession>;
