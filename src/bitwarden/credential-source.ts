/**
 * Which credentials the backend boots with (VAULT-18): the stored account-page
 * connection wins; otherwise the three `VAULTGATE_BW_*` variables when all are
 * present; otherwise the backend starts unconfigured and waits for the
 * account page.
 */
import { Credentials, type CredentialValues } from './credentials.ts';

import type { StoredVaultSettings } from './settings.ts';
import type { Config } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultCredentialOrigin } from '../vault/connection.ts';

export interface ResolvedCredentials {
  readonly origin: Exclude<VaultCredentialOrigin, 'none'>;
  readonly credentials: Credentials;
}

type SourceConfig = Pick<Config, 'bitwarden' | 'secrets'>;

/**
The environment's seed, complete or absent; a partial set is reported and ignored.
*/
export function environmentCredentials(
  config: SourceConfig,
  logger: Logger,
): CredentialValues | undefined {
  const { clientId, server } = config.bitwarden;
  const { clientSecret, masterPassword } = config.secrets;
  const present = [clientId, clientSecret, masterPassword].filter(
    (value) => value !== undefined,
  ).length;
  if (
    present === 3 &&
    clientId !== undefined &&
    clientSecret !== undefined &&
    masterPassword !== undefined
  ) {
    return { clientId, clientSecret, masterPassword, server };
  }
  if (present > 0) {
    logger.warn(
      'VAULTGATE_BW_CLIENT_ID, VAULTGATE_BW_CLIENT_SECRET and VAULTGATE_BW_PASSWORD must all be set to seed the vault connection; ignoring the partial set',
    );
  }
  return undefined;
}

export function resolveCredentials(
  config: SourceConfig,
  stored: StoredVaultSettings,
  logger: Logger,
): ResolvedCredentials | undefined {
  if (stored.kind === 'ok') {
    return { origin: 'settings', credentials: new Credentials(stored.values) };
  }
  if (stored.kind === 'undecryptable') {
    logger.warn(
      'the stored vault connection cannot be decrypted under VAULTGATE_SECRET_KEY; save it again on the account page',
    );
  }
  const seed = environmentCredentials(config, logger);
  return seed === undefined
    ? undefined
    : { origin: 'environment', credentials: new Credentials(seed) };
}
