/**
 * The account page's view of the vault (VAULT-18, ID-25) over the supervisor
 * and the stored settings: status to render, and "save then switch" with the
 * stored row rolled back when the switch fails, so what is stored is always
 * what runs.
 */
import { fail, ok, type Result } from '../result.ts';
import { VaultError } from '../vault/client.ts';

import type { CredentialValues } from './credentials.ts';
import type { VaultSettings } from './settings.ts';
import type { VaultSupervisor } from './supervisor.ts';
import type {
  VaultConnection,
  VaultConnectionInput,
  VaultConnectionStatus,
} from '../vault/connection.ts';

export interface VaultConnectionDependencies {
  readonly supervisor: VaultSupervisor;
  readonly settings: VaultSettings;
  readonly clock: () => number;
}

const NOTHING_TO_KEEP =
  'no vault connection is configured yet: enter both the client secret and the master password';

/**
A blank secret keeps the one the backend runs with; with nothing running, both are required.
*/
function merge(
  input: VaultConnectionInput,
  supervisor: VaultSupervisor,
): Result<CredentialValues, VaultError> {
  const running = supervisor.credentials();
  const clientSecret = input.clientSecret ?? running?.clientSecret();
  const masterPassword = input.masterPassword ?? running?.masterPassword();
  return clientSecret === undefined || masterPassword === undefined
    ? fail(new VaultError('vault_unavailable', NOTHING_TO_KEEP))
    : ok({ clientId: input.clientId, server: input.serverUrl, clientSecret, masterPassword });
}

export function createVaultConnection(dependencies: VaultConnectionDependencies): VaultConnection {
  const { supervisor, settings, clock } = dependencies;
  return {
    status: async (): Promise<VaultConnectionStatus> => {
      const source = supervisor.source();
      const isReady = supervisor.isReady();
      const live = isReady ? await supervisor.client.status() : undefined;
      const status = live?.ok ? live.value : undefined;
      return {
        configured: source.origin !== 'none',
        origin: source.origin,
        serverUrl: status?.serverUrl ?? source.serverUrl,
        ready: isReady,
        userEmailMasked: status?.userEmailMasked ?? null,
        lastSyncAt: supervisor.syncState().lastSyncAt,
      };
    },
    configure: async (input, operatorId) => {
      const merged = merge(input, supervisor);
      if (!merged.ok) {
        return merged;
      }
      const previous = settings.save(merged.value, operatorId, clock());
      const switched = await supervisor.reconfigure(merged.value);
      if (!switched.ok) {
        settings.restore(previous);
      }
      return switched;
    },
  };
}
