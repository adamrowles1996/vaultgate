import { DEFAULT_SERVER_URL } from '../bitwarden/requests.ts';
import { fail, ok, type Result } from '../result.ts';
import { VaultError } from '../vault/client.ts';

import type {
  VaultConnection,
  VaultConnectionInput,
  VaultConnectionStatus,
} from '../vault/connection.ts';

const UNCONFIGURED_VAULT: VaultConnectionStatus = {
  configured: false,
  origin: 'none',
  serverUrl: DEFAULT_SERVER_URL,
  ready: false,
  userEmailMasked: null,
  lastSyncAt: null,
};

export const ENVIRONMENT_VAULT: VaultConnectionStatus = {
  configured: true,
  origin: 'environment',
  serverUrl: 'https://vault.example.test',
  ready: true,
  userEmailMasked: 'a***@example.com',
  lastSyncAt: '2026-09-22T11:00:00.000Z',
};

export interface ConfigureCall {
  readonly input: VaultConnectionInput;
  readonly operatorId: string;
}

/**
 * The identity harness's vault: a settable status and a `configure` that
 * records what it was given and either succeeds (becoming the configured
 * status) or fails with the scripted message.
 */
export class FakeVaultConnection implements VaultConnection {
  current: VaultConnectionStatus = UNCONFIGURED_VAULT;
  failWith: string | undefined;
  readonly calls: ConfigureCall[] = [];

  status(): Promise<VaultConnectionStatus> {
    return Promise.resolve(this.current);
  }

  configure(input: VaultConnectionInput, operatorId: string): Promise<Result<void, VaultError>> {
    this.calls.push({ input, operatorId });
    if (this.failWith !== undefined) {
      return Promise.resolve(fail(new VaultError('vault_unavailable', this.failWith)));
    }
    this.current = {
      configured: true,
      origin: 'settings',
      serverUrl: input.serverUrl ?? DEFAULT_SERVER_URL,
      ready: true,
      userEmailMasked: 'a***@example.com',
      lastSyncAt: '2026-09-22T12:00:00.000Z',
    };
    return Promise.resolve(ok(undefined));
  }
}
