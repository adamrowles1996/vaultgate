/**
 * The fields of a vault item as the forms offer them (ACT-4, ACT-6): what a
 * credential mapping may name, read off the item's summary, which carries no
 * secret. A secret field is named and never shown; the login name and a text
 * custom field show their value, which the vault does not hold as secret.
 */
import type { FieldPicker } from './descriptors.ts';
import type { CustomFieldSummary, ItemSummary, LoginSummary } from '../../vault/client.ts';

/**
A field a mapping may name: its selector (`login.username`, `password`, `custom.<name>`, …).
*/
export type ItemField = { readonly selector: string; readonly label: string } & (
  { readonly isSecret: true } | { readonly isSecret: false; readonly value: string }
);

export const USERNAME_SELECTOR = 'login.username';

function secret(selector: string, label: string): ItemField {
  return { selector, label, isSecret: true };
}

function loginFields(login: LoginSummary | null): readonly ItemField[] {
  if (login === null) {
    return [];
  }
  return [
    ...(login.username === null
      ? []
      : [
          {
            selector: USERNAME_SELECTOR,
            label: 'Username',
            isSecret: false,
            value: login.username,
          },
        ]),
    ...(login.hasPassword ? [secret('password', 'Password')] : []),
    ...(login.hasTotp ? [secret('totp', 'One-time code (TOTP)')] : []),
  ];
}

const TYPE_FIELDS: Readonly<Partial<Record<ItemSummary['type'], readonly ItemField[]>>> = {
  sshKey: [secret('sshKey.privateKey', 'SSH private key')],
  card: [secret('card.number', 'Card number'), secret('card.code', 'Card security code')],
};

/**
A text field shows its value; a hidden one is sealed; a check box or a link is not a credential.
*/
function customField(field: CustomFieldSummary): readonly ItemField[] {
  const selector = `custom.${field.name}`;
  switch (field.kind) {
    case 'text': {
      return [{ selector, label: field.name, isSecret: false, value: field.value ?? '' }];
    }
    case 'hidden': {
      return [secret(selector, field.name)];
    }
    default: {
      return [];
    }
  }
}

/**
Every field of `item` a mapping may name, in the order the vault shows them.
*/
export function itemFields(item: ItemSummary): readonly ItemField[] {
  return [
    ...loginFields(item.login),
    ...(TYPE_FIELDS[item.type] ?? []),
    ...(item.hasNotes ? [secret('notes', 'Notes')] : []),
    ...item.customFields.flatMap((field) => customField(field)),
  ];
}

/**
The fields a picker offers: a username may come from any of them, a secret from any but the login name.
*/
export function offeredFields(
  fields: readonly ItemField[],
  picker: FieldPicker,
): readonly ItemField[] {
  return picker.role === 'secret'
    ? fields.filter((field) => field.selector !== USERNAME_SELECTOR)
    : fields;
}

/**
What a picker shows selected: the value the form holds, else the schema's default; an optional field names none.
*/
export function pickedSelector(current: string, picker: FieldPicker): string {
  if (current !== '') {
    return current;
  }
  return 'fallback' in picker ? picker.fallback : '';
}
