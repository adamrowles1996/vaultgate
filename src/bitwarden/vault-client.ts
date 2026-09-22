/**
 * `VaultClient` over the `bw serve` Vault Management API (VAULT-11). Every
 * call is one `BwServeApi` request validated by a zod schema; writes wait for
 * the new revision to be readable before returning (VAULT-10, `writes.ts`).
 */
import { fail, ok } from '../result.ts';

import { type BwServeApi, vaultError } from './api.ts';
import { itemTypeOf, secretFromItem, summariseItem } from './items.ts';
import {
  DEFAULT_SERVER_URL,
  fieldPath,
  generatePath,
  itemPath,
  searchPath,
  toVaultStatus,
  unavailableStatus,
} from './requests.ts';
import {
  collectionListSchema,
  folderListSchema,
  itemListSchema,
  itemSchema,
  messageDataSchema,
  type RawItem,
  statusDataSchema,
  stringDataSchema,
} from './types.ts';
import { createFolder, createItem, trashItem, updateItem } from './writes.ts';

import type { Clock } from './clock.ts';
import type {
  Collection,
  Folder,
  ItemPatch,
  ItemSummary,
  NewItem,
  PassphraseOptions,
  PasswordOptions,
  SearchQuery,
  SecretField,
  SecretValue,
  VaultClient,
  VaultResult,
  VaultStatus,
} from '../vault/client.ts';

const TOTP_PERIOD_SECONDS = 30;

export interface BwServeVaultClientOptions {
  readonly api: BwServeApi;
  readonly clock: Clock;
  /**
  Reported when `bw serve` names no server (the bitwarden.com default).
  */
  readonly serverUrl?: string;
}

export class BwServeVaultClient implements VaultClient {
  readonly #api: BwServeApi;
  readonly #clock: Clock;
  readonly #serverUrl: string;

  constructor(options: BwServeVaultClientOptions) {
    this.#api = options.api;
    this.#clock = options.clock;
    this.#serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;
  }

  async #string(path: string): VaultResult<string> {
    const result = await this.#api.call({ method: 'GET', path, schema: stringDataSchema });
    return result.ok ? ok(result.value.data) : result;
  }

  async #listItems(query: SearchQuery, isTrash: boolean): VaultResult<readonly RawItem[]> {
    const result = await this.#api.call({
      method: 'GET',
      path: searchPath(query, isTrash),
      schema: itemListSchema,
    });
    return result.ok ? ok(result.value.data) : result;
  }

  async #totp(id: string): VaultResult<SecretValue> {
    const code = await this.#string(fieldPath('totp', id));
    if (!code.ok) {
      return code;
    }
    const elapsed = Math.floor(this.#clock.now() / 1000) % TOTP_PERIOD_SECONDS;
    return ok({ kind: 'totp', code: code.value, secondsRemaining: TOTP_PERIOD_SECONDS - elapsed });
  }

  async #itemSecret(id: string, field: SecretField): VaultResult<SecretValue> {
    const raw = await this.#api.call({ method: 'GET', path: itemPath(id), schema: itemSchema });
    if (!raw.ok) {
      return raw;
    }
    const value = secretFromItem(raw.value, field);
    return value === undefined ? fail(vaultError('not_found')) : ok({ kind: 'text', value });
  }

  async status(): VaultResult<VaultStatus> {
    const result = await this.#api.call({
      method: 'GET',
      path: '/status',
      schema: statusDataSchema,
    });
    if (result.ok) {
      return ok(toVaultStatus(result.value.template, this.#serverUrl));
    }
    return result.error.code === 'vault_unavailable'
      ? ok(unavailableStatus(this.#serverUrl))
      : result;
  }

  async sync(): VaultResult<void> {
    const result = await this.#api.call({
      method: 'POST',
      path: '/sync',
      schema: messageDataSchema,
    });
    return result.ok ? ok(undefined) : result;
  }

  async searchItems(query: SearchQuery): VaultResult<readonly ItemSummary[]> {
    const live = await this.#listItems(query, false);
    if (!live.ok) {
      return live;
    }
    const trashed = query.includeTrash === true ? await this.#listItems(query, true) : ok([]);
    if (!trashed.ok) {
      return trashed;
    }
    const matches = [...live.value, ...trashed.value].filter(
      (item) => query.type === undefined || itemTypeOf(item) === query.type,
    );
    return ok(matches.slice(0, query.limit).map((item) => summariseItem(item)));
  }

  async getItem(id: string): VaultResult<ItemSummary> {
    const raw = await this.#api.call({ method: 'GET', path: itemPath(id), schema: itemSchema });
    return raw.ok ? ok(summariseItem(raw.value)) : raw;
  }

  async getSecret(id: string, field: SecretField): VaultResult<SecretValue> {
    switch (field.kind) {
      case 'password':
      case 'notes': {
        const value = await this.#string(fieldPath(field.kind, id));
        return value.ok ? ok({ kind: 'text', value: value.value }) : value;
      }
      case 'totp': {
        return this.#totp(id);
      }
      default: {
        return this.#itemSecret(id, field);
      }
    }
  }

  async listFolders(): VaultResult<readonly Folder[]> {
    const result = await this.#api.call({
      method: 'GET',
      path: '/list/object/folders',
      schema: folderListSchema,
    });
    if (!result.ok) {
      return result;
    }
    const folders: Folder[] = [];
    for (const folder of result.value.data) {
      if (folder.id !== null) {
        folders.push({ id: folder.id, name: folder.name });
      }
    }
    return ok(folders);
  }

  async listCollections(): VaultResult<readonly Collection[]> {
    const result = await this.#api.call({
      method: 'GET',
      path: '/list/object/collections',
      schema: collectionListSchema,
    });
    return result.ok ? ok(result.value.data) : result;
  }

  generatePassword(options: PasswordOptions): VaultResult<string> {
    return this.#string(
      generatePath({
        length: options.length,
        uppercase: options.uppercase,
        lowercase: options.lowercase,
        number: options.numbers,
        special: options.special,
      }),
    );
  }

  generatePassphrase(options: PassphraseOptions): VaultResult<string> {
    return this.#string(
      generatePath({
        passphrase: true,
        words: options.words,
        separator: options.separator,
        capitalize: options.capitalize,
        includeNumber: options.includeNumber,
      }),
    );
  }

  createItem(item: NewItem): VaultResult<ItemSummary> {
    return createItem({ api: this.#api, clock: this.#clock }, item);
  }

  updateItem(id: string, patch: ItemPatch): VaultResult<ItemSummary> {
    return updateItem({ api: this.#api, clock: this.#clock }, id, patch);
  }

  trashItem(id: string): VaultResult<void> {
    return trashItem({ api: this.#api, clock: this.#clock }, id);
  }

  createFolder(name: string): VaultResult<Folder> {
    return createFolder(this.#api, name);
  }
}
