/**
 * The field selector grammar `get_secret` accepts (spec §06.2) and the
 * actions layer's credential mappings reuse (ACT-4, §14): `password`, `totp`,
 * `notes`, `card.number`, `card.code`, `sshKey.privateKey`,
 * `identity.<field>`, `custom.<name>`, plus the non-secret `login.username`.
 */
import type { ItemSummary, LoginSummary, SecretField } from './client.ts';

const FIXED_FIELDS: Readonly<Record<string, SecretField>> = {
  password: { kind: 'password' },
  totp: { kind: 'totp' },
  notes: { kind: 'notes' },
  'card.number': { kind: 'card', field: 'number' },
  'card.code': { kind: 'card', field: 'code' },
  'sshKey.privateKey': { kind: 'sshKey', field: 'privateKey' },
};

const IDENTITY_PREFIX = 'identity.';
const CUSTOM_PREFIX = 'custom.';
const USERNAME_SELECTOR = 'login.username';

/**
Parses a secret field selector into the vault contract's discriminated union.
*/
export function parseSecretField(text: string): SecretField | undefined {
  const fixed = FIXED_FIELDS[text];
  if (fixed !== undefined) {
    return fixed;
  }
  if (text.startsWith(IDENTITY_PREFIX) && text.length > IDENTITY_PREFIX.length) {
    return { kind: 'identity', field: text.slice(IDENTITY_PREFIX.length) };
  }
  return text.startsWith(CUSTOM_PREFIX) && text.length > CUSTOM_PREFIX.length
    ? { kind: 'customField', name: text.slice(CUSTOM_PREFIX.length) }
    : undefined;
}

export type FieldSelector = SecretField | { readonly kind: 'username' };

/**
A secret selector or `login.username`, the one non-secret field a mapping may name.
*/
export function parseFieldSelector(text: string): FieldSelector | undefined {
  return text === USERNAME_SELECTOR ? { kind: 'username' } : parseSecretField(text);
}

function isLoginFieldPresent(
  login: LoginSummary | null,
  kind: 'username' | 'password' | 'totp',
): boolean {
  if (login === null) {
    return false;
  }
  switch (kind) {
    case 'username': {
      return login.username !== null;
    }
    case 'password': {
      return login.hasPassword;
    }
    case 'totp': {
      return login.hasTotp;
    }
  }
}

/**
 * ACT-4: whether the item reports the selected field as present. Secret
 * values are never read here; the summary's flags and field list decide.
 */
export function isFieldPresent(item: ItemSummary, selector: FieldSelector): boolean {
  switch (selector.kind) {
    case 'username':
    case 'password':
    case 'totp': {
      return isLoginFieldPresent(item.login, selector.kind);
    }
    case 'notes': {
      return item.hasNotes;
    }
    case 'card': {
      return item.type === 'card';
    }
    case 'identity': {
      return item.type === 'identity';
    }
    case 'sshKey': {
      return item.type === 'sshKey';
    }
    case 'customField': {
      return item.customFields.some((field) => field.name === selector.name);
    }
  }
}
