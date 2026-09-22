/**
 * A `VaultClient` with no vault behind it: every call fails with
 * `vault_unavailable` (VAULT-5). Wired in `main.ts` until the managed
 * `bw serve` client lands, so the MCP surface is reachable and honest about
 * its state rather than absent.
 */
import { fail, type Result } from '../result.ts';

import { type VaultClient, VaultError } from './client.ts';

function unavailable<T>(): Promise<Result<T, VaultError>> {
  return Promise.resolve(
    fail(new VaultError('vault_unavailable', 'the vault backend is not running')),
  );
}

export class UnavailableVaultClient implements VaultClient {
  status(): ReturnType<VaultClient['status']> {
    return unavailable();
  }

  sync(): ReturnType<VaultClient['sync']> {
    return unavailable();
  }

  searchItems(): ReturnType<VaultClient['searchItems']> {
    return unavailable();
  }

  getItem(): ReturnType<VaultClient['getItem']> {
    return unavailable();
  }

  getSecret(): ReturnType<VaultClient['getSecret']> {
    return unavailable();
  }

  listFolders(): ReturnType<VaultClient['listFolders']> {
    return unavailable();
  }

  listCollections(): ReturnType<VaultClient['listCollections']> {
    return unavailable();
  }

  generatePassword(): ReturnType<VaultClient['generatePassword']> {
    return unavailable();
  }

  generatePassphrase(): ReturnType<VaultClient['generatePassphrase']> {
    return unavailable();
  }

  createItem(): ReturnType<VaultClient['createItem']> {
    return unavailable();
  }

  updateItem(): ReturnType<VaultClient['updateItem']> {
    return unavailable();
  }

  trashItem(): ReturnType<VaultClient['trashItem']> {
    return unavailable();
  }

  createFolder(): ReturnType<VaultClient['createFolder']> {
    return unavailable();
  }
}
