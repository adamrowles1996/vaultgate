/**
 * The operator-facing contract for the vault connection (spec §04 ID-25,
 * §05 VAULT-18). The identity module renders and submits through this
 * interface only; `src/bitwarden/` implements it over the supervisor and the
 * stored settings, and `src/test-support/` provides a fake. Nothing here
 * carries a secret outwards: the status is safe to render and to log.
 */
import type { Result } from '../result.ts';
import type { VaultError } from './client.ts';

/**
Where the running credentials came from; `none` is the unconfigured state.
*/
export type VaultCredentialOrigin = 'settings' | 'environment' | 'none';

export interface VaultConnectionStatus {
  readonly configured: boolean;
  readonly origin: VaultCredentialOrigin;
  /**
  The server the CLI is pointed at (the cloud default when none is set).
  */
  readonly serverUrl: string;
  readonly ready: boolean;
  /**
  From `bw serve`'s `/status` while ready; `null` otherwise.
  */
  readonly userEmailMasked: string | null;
  readonly lastSyncAt: string | null;
}

/**
 * What the account page submits. An `undefined` secret keeps the value the
 * connection currently runs with, so the page never has to echo one back.
 */
export interface VaultConnectionInput {
  readonly serverUrl: string | undefined;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly masterPassword: string | undefined;
}

export interface VaultConnection {
  status(): Promise<VaultConnectionStatus>;
  /**
   * Stores the connection and switches the backend to it. A failure restores
   * the previous stored row and the previous running state; its message is
   * secret-free and safe to show the operator.
   */
  configure(input: VaultConnectionInput, operatorId: string): Promise<Result<void, VaultError>>;
}
