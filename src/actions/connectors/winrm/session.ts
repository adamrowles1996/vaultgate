/**
 * The transport one `winrm_run` runs over (ACT-78): one WS-Management shell
 * per call, created after the policy decision, used for one command and
 * deleted when the call ends (ACT-28, ACT-58). `client.ts` implements it over
 * the pinned HTTPS transport; `src/test-support/fake-wsman.ts` implements the
 * destination side for the contract tests, so no test needs a Windows host.
 */
import type { WinrmShell } from './envelopes.ts';

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
