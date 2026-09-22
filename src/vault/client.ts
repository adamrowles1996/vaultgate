/**
 * The vault contract every tool depends on (spec §05.3, VAULT-11). The MCP
 * layer imports only this module; `src/bitwarden/` implements it against a
 * managed `bw serve`, and `src/test-support/` provides an in-memory fake.
 *
 * Every method returns a `Result` so callers map failures to tool errors
 * without catching. Secret material is reachable only through `getSecret`.
 */
import type { Result } from '../result.ts';

export type ItemType = 'login' | 'secureNote' | 'card' | 'identity' | 'sshKey';

export type CustomFieldKind = 'text' | 'hidden' | 'boolean' | 'linked';

export interface CustomFieldSummary {
  readonly name: string;
  readonly kind: CustomFieldKind;
  /**
  Present for `text` and `boolean` fields; always `null` for `hidden` and `linked`.
  */
  readonly value: string | null;
}

export interface LoginSummary {
  readonly username: string | null;
  readonly uris: readonly string[];
  readonly hasPassword: boolean;
  readonly hasTotp: boolean;
}

/**
Everything about an item except secret values.
*/
export interface ItemSummary {
  readonly id: string;
  readonly name: string;
  readonly type: ItemType;
  readonly folderId: string | null;
  readonly organizationId: string | null;
  readonly collectionIds: readonly string[];
  readonly favorite: boolean;
  readonly revisionDate: string;
  readonly deletedDate: string | null;
  readonly login: LoginSummary | null;
  readonly hasNotes: boolean;
  readonly customFields: readonly CustomFieldSummary[];
}

export interface SearchQuery {
  readonly text?: string;
  readonly type?: ItemType;
  readonly folderId?: string;
  readonly collectionId?: string;
  readonly url?: string;
  readonly includeTrash?: boolean;
  /**
  Hard-capped by the caller (MCP-5 uses 50).
  */
  readonly limit: number;
}

export type SecretField =
  | { readonly kind: 'password' }
  | { readonly kind: 'totp' }
  | { readonly kind: 'notes' }
  | { readonly kind: 'card'; readonly field: 'number' | 'code' }
  | { readonly kind: 'identity'; readonly field: string }
  | { readonly kind: 'sshKey'; readonly field: 'privateKey' }
  | { readonly kind: 'customField'; readonly name: string };

export type SecretValue =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'totp'; readonly code: string; readonly secondsRemaining: number };

export interface Folder {
  readonly id: string;
  readonly name: string;
}

export interface Collection {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
}

export type VaultLockState = 'unlocked' | 'locked' | 'unauthenticated' | 'unavailable';

export interface VaultStatus {
  readonly serverUrl: string;
  /**
  e-mail with the local part masked, e.g. `a***@example.com`.
  */
  readonly userEmailMasked: string | null;
  readonly state: VaultLockState;
  readonly lastSyncAt: string | null;
}

export interface PasswordOptions {
  readonly length: number;
  readonly uppercase: boolean;
  readonly lowercase: boolean;
  readonly numbers: boolean;
  readonly special: boolean;
}

export interface PassphraseOptions {
  readonly words: number;
  readonly separator: string;
  readonly capitalize: boolean;
  readonly includeNumber: boolean;
}

export interface NewLoginFields {
  readonly username?: string;
  readonly password?: string;
  readonly uris?: readonly string[];
}

export interface NewItem {
  readonly type: 'login' | 'secureNote';
  readonly name: string;
  readonly folderId?: string;
  readonly notes?: string;
  readonly favorite?: boolean;
  readonly login?: NewLoginFields;
}

export interface ItemPatch {
  readonly name?: string;
  readonly folderId?: string | null;
  readonly notes?: string;
  readonly favorite?: boolean;
  readonly login?: NewLoginFields;
}

export type VaultErrorCode =
  'vault_unavailable' | 'not_found' | 'invalid_item' | 'vault_protocol_error';

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export type VaultResult<T> = Promise<Result<T, VaultError>>;

export interface VaultClient {
  status(): VaultResult<VaultStatus>;
  sync(): VaultResult<void>;
  searchItems(query: SearchQuery): VaultResult<readonly ItemSummary[]>;
  getItem(id: string): VaultResult<ItemSummary>;
  getSecret(id: string, field: SecretField): VaultResult<SecretValue>;
  listFolders(): VaultResult<readonly Folder[]>;
  listCollections(): VaultResult<readonly Collection[]>;
  generatePassword(options: PasswordOptions): VaultResult<string>;
  generatePassphrase(options: PassphraseOptions): VaultResult<string>;
  createItem(item: NewItem): VaultResult<ItemSummary>;
  updateItem(id: string, patch: ItemPatch): VaultResult<ItemSummary>;
  trashItem(id: string): VaultResult<void>;
  createFolder(name: string): VaultResult<Folder>;
}
