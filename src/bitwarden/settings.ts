/**
 * The stored vault connection in clear, for the supervisor and the account
 * page (STORE-9). Two secret boxes, one per secret, under distinct HKDF
 * purposes of `VAULTGATE_SECRET_KEY`; a row sealed under a different key
 * opens as `undecryptable` rather than as garbage.
 */
import {
  createSecretBox,
  type RandomSource,
  VAULT_CLIENT_SECRET_INFO,
  VAULT_MASTER_PASSWORD_INFO,
} from '../crypto/secret-box.ts';

import { createVaultSettingsStore, type VaultSettingsRecord } from './settings-store.ts';

import type { CredentialValues } from './credentials.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface VaultSettingsDependencies {
  readonly database: DatabaseSync;
  readonly secretKey: Buffer;
  readonly random: RandomSource;
}

export type StoredVaultSettings =
  | { readonly kind: 'none' }
  | { readonly kind: 'undecryptable' }
  | { readonly kind: 'ok'; readonly values: CredentialValues; readonly updatedAt: number };

export interface VaultSettings {
  load(): StoredVaultSettings;
  /**
  Seals and stores `values` as the single row; returns what the row replaced.
  */
  save(values: CredentialValues, operatorId: string, now: number): VaultSettingsRecord | undefined;
  /**
  Puts back the row `save` replaced (or removes the row when there was none).
  */
  restore(previous: VaultSettingsRecord | undefined): void;
}

export function createVaultSettings(dependencies: VaultSettingsDependencies): VaultSettings {
  const { database, secretKey, random } = dependencies;
  const store = createVaultSettingsStore(database);
  const secretBox = createSecretBox(secretKey, VAULT_CLIENT_SECRET_INFO, random);
  const passwordBox = createSecretBox(secretKey, VAULT_MASTER_PASSWORD_INFO, random);
  return {
    load: () => {
      const record = store.find();
      if (record === undefined) {
        return { kind: 'none' };
      }
      const clientSecret = secretBox.open(record.clientSecretCiphertext);
      const masterPassword = passwordBox.open(record.masterPasswordCiphertext);
      if (clientSecret === undefined || masterPassword === undefined) {
        return { kind: 'undecryptable' };
      }
      return {
        kind: 'ok',
        updatedAt: record.updatedAt,
        values: {
          clientId: record.clientId,
          server: record.serverUrl,
          clientSecret: clientSecret.toString('utf8'),
          masterPassword: masterPassword.toString('utf8'),
        },
      };
    },
    save: (values, operatorId, now) => {
      const previous = store.find();
      store.save({
        serverUrl: values.server,
        clientId: values.clientId,
        clientSecretCiphertext: secretBox.seal(Buffer.from(values.clientSecret, 'utf8')),
        masterPasswordCiphertext: passwordBox.seal(Buffer.from(values.masterPassword, 'utf8')),
        updatedAt: now,
        updatedBy: operatorId,
      });
      return previous;
    },
    restore: (previous) => {
      if (previous === undefined) {
        store.clear();
      } else {
        store.save(previous);
      }
    },
  };
}
