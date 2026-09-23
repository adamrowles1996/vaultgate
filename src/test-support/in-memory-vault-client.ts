import { fail, ok, type Result } from '../result.ts';
import {
  type Collection,
  type Folder,
  type ItemPatch,
  type ItemSummary,
  type NewItem,
  type PassphraseOptions,
  type PasswordOptions,
  type SearchQuery,
  type SecretField,
  type SecretValue,
  type VaultClient,
  VaultError,
  type VaultResult,
  type VaultStatus,
} from '../vault/client.ts';

import {
  FIXED_NOW,
  mergedCustomFields,
  mergedLogin,
  mergedSecrets,
  newLogin,
  predicatesFor,
  secretLookup,
} from './in-memory-vault-logic.ts';
import {
  FIXTURE_COLLECTIONS,
  FIXTURE_FOLDERS,
  FIXTURE_ITEMS,
  type ItemSecrets,
  type StoredItem,
} from './vault-fixture.ts';

/**
 * The fake behind every tool test (ARCH-6, VAULT-11): a mutable copy of the
 * fixture vault with deterministic ids, clock and generated secrets.
 */
export class InMemoryVaultClient implements VaultClient {
  readonly #items = new Map<string, StoredItem>();
  readonly #folders: Folder[] = [...FIXTURE_FOLDERS];
  readonly #collections: readonly Collection[] = [...FIXTURE_COLLECTIONS];
  #forcedError: VaultError | null = null;
  #sequence = 0;

  constructor(items: readonly StoredItem[] = FIXTURE_ITEMS) {
    for (const item of items) {
      this.#items.set(item.summary.id, item);
    }
  }

  #respond<T>(value: T): Promise<Result<T, VaultError>> {
    return Promise.resolve(this.#forcedError === null ? ok(value) : fail(this.#forcedError));
  }

  #reject(error: VaultError): Promise<Result<never, VaultError>> {
    return Promise.resolve(fail(this.#forcedError ?? error));
  }

  #notFound(id: string): Promise<Result<never, VaultError>> {
    return this.#reject(new VaultError('not_found', `no item with id ${id}`));
  }

  /**
  Makes every subsequent call fail with `error` (or clears the failure with `null`).
  */
  failWith(error: VaultError | null): void {
    this.#forcedError = error;
  }

  /**
  Test-only peek at stored secrets, so write tests can assert what was saved.
  */
  storedSecrets(id: string): ItemSecrets | undefined {
    return this.#items.get(id)?.secrets;
  }

  status(): VaultResult<VaultStatus> {
    return this.#respond({
      serverUrl: 'https://vault.bitwarden.com',
      userEmailMasked: 'a***@example.com',
      state: 'unlocked',
      lastSyncAt: FIXED_NOW,
    });
  }

  sync(): VaultResult<void> {
    return this.#respond(undefined);
  }

  searchItems(query: SearchQuery): VaultResult<readonly ItemSummary[]> {
    const predicates = predicatesFor(query);
    const matches: ItemSummary[] = [];
    for (const { summary } of this.#items.values()) {
      if (predicates.every((predicate) => predicate(summary))) {
        matches.push(summary);
      }
    }
    return this.#respond(matches.slice(0, query.limit));
  }

  getItem(id: string): VaultResult<ItemSummary> {
    const item = this.#items.get(id);
    return item === undefined ? this.#notFound(id) : this.#respond(item.summary);
  }

  getSecret(id: string, field: SecretField): VaultResult<SecretValue> {
    const item = this.#items.get(id);
    if (item === undefined) {
      return this.#notFound(id);
    }
    const value = secretLookup(item.secrets, field);
    return value === undefined
      ? this.#reject(new VaultError('invalid_item', `item ${id} has no ${field.kind} field`))
      : this.#respond(value);
  }

  listFolders(): VaultResult<readonly Folder[]> {
    return this.#respond([...this.#folders]);
  }

  listCollections(): VaultResult<readonly Collection[]> {
    return this.#respond(this.#collections);
  }

  generatePassword(options: PasswordOptions): VaultResult<string> {
    const classes = [
      options.uppercase ? 'A' : '',
      options.lowercase ? 'a' : '',
      options.numbers ? '1' : '',
      options.special ? '!' : '',
    ].join('');
    return this.#respond(classes.repeat(options.length).slice(0, options.length));
  }

  generatePassphrase(options: PassphraseOptions): VaultResult<string> {
    const words = Array.from({ length: options.words }, (_, index) =>
      options.capitalize ? `Word${index + 1}` : `word${index + 1}`,
    );
    const phrase = words.join(options.separator);
    return this.#respond(options.includeNumber ? `${phrase}${options.separator}7` : phrase);
  }

  createItem(item: NewItem): VaultResult<ItemSummary> {
    if (item.name.trim() === '') {
      return this.#reject(new VaultError('invalid_item', 'name must not be empty'));
    }
    this.#sequence += 1;
    const id = `item-new-${this.#sequence}`;
    const secrets: ItemSecrets = {
      ...(item.login?.password !== undefined && { password: item.login.password }),
      ...(item.notes !== undefined && { notes: item.notes }),
    };
    const summary: ItemSummary = {
      id,
      name: item.name,
      type: item.type,
      folderId: item.folderId ?? null,
      organizationId: null,
      collectionIds: [],
      favorite: item.favorite ?? false,
      revisionDate: FIXED_NOW,
      deletedDate: null,
      login: newLogin(item, secrets),
      hasNotes: item.notes !== undefined,
      customFields: [],
    };
    this.#items.set(id, { summary, secrets });
    return this.#respond(summary);
  }

  updateItem(id: string, patch: ItemPatch): VaultResult<ItemSummary> {
    const existing = this.#items.get(id);
    if (existing === undefined) {
      return this.#notFound(id);
    }
    const secrets = mergedSecrets(existing.secrets, patch);
    const summary: ItemSummary = {
      ...existing.summary,
      name: patch.name ?? existing.summary.name,
      folderId: patch.folderId === undefined ? existing.summary.folderId : patch.folderId,
      favorite: patch.favorite ?? existing.summary.favorite,
      hasNotes: secrets.notes !== undefined,
      login: mergedLogin(existing.summary.login, patch, secrets),
      customFields: mergedCustomFields(existing.summary.customFields, patch),
      revisionDate: FIXED_NOW,
    };
    this.#items.set(id, { summary, secrets });
    return this.#respond(summary);
  }

  trashItem(id: string): VaultResult<void> {
    const existing = this.#items.get(id);
    if (existing === undefined) {
      return this.#notFound(id);
    }
    this.#items.set(id, {
      ...existing,
      summary: { ...existing.summary, deletedDate: FIXED_NOW },
    });
    return this.#respond(undefined);
  }

  createFolder(name: string): VaultResult<Folder> {
    this.#sequence += 1;
    const folder = { id: `folder-new-${this.#sequence}`, name };
    this.#folders.push(folder);
    return this.#respond(folder);
  }
}
