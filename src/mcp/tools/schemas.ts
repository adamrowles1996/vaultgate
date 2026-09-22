/**
 * Output schemas shared by several tools. Every schema is strict: a key that
 * is not declared here cannot reach an agent, which is how MCP-9 is enforced
 * structurally rather than by convention.
 */
import { z } from 'zod';

import type { CustomFieldKind, ItemSummary, ItemType, VaultLockState } from '../../vault/client.ts';

const ITEM_TYPES = [
  'login',
  'secureNote',
  'card',
  'identity',
  'sshKey',
] as const satisfies readonly ItemType[];
const FIELD_KINDS = [
  'text',
  'hidden',
  'boolean',
  'linked',
] as const satisfies readonly CustomFieldKind[];
export const LOCK_STATES = [
  'unlocked',
  'locked',
  'unauthenticated',
  'unavailable',
] as const satisfies readonly VaultLockState[];

export const itemTypeSchema = z.enum(ITEM_TYPES);

export const itemIdSchema = z
  .string()
  .min(1)
  .describe('The item id, as returned by search_items or get_item.');

const loginSummarySchema = z.strictObject({
  username: z.string().nullable(),
  uris: z.array(z.string()),
  has_password: z
    .boolean()
    .describe('True when a password is stored; the value is never included.'),
  has_totp: z
    .boolean()
    .describe('True when a TOTP seed is stored; use get_secret with field "totp" for a code.'),
});

const customFieldSummarySchema = z.strictObject({
  name: z.string(),
  kind: z.enum(FIELD_KINDS),
  value: z
    .string()
    .nullable()
    .describe('Present for text and boolean fields; always null for hidden and linked fields.'),
});

export const itemSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: itemTypeSchema,
  folder_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  collection_ids: z.array(z.string()),
  favorite: z.boolean(),
  revision_date: z.string(),
  deleted_date: z.string().nullable().describe('Set when the item is in the trash.'),
  login: loginSummarySchema.nullable(),
  has_notes: z
    .boolean()
    .describe('True when notes exist; notes are secret and only readable via get_secret.'),
  custom_fields: z.array(customFieldSummarySchema),
});

export type ItemSummaryOutput = z.output<typeof itemSummarySchema>;

export function toItemSummaryOutput(summary: ItemSummary): ItemSummaryOutput {
  return {
    id: summary.id,
    name: summary.name,
    type: summary.type,
    folder_id: summary.folderId,
    organization_id: summary.organizationId,
    collection_ids: [...summary.collectionIds],
    favorite: summary.favorite,
    revision_date: summary.revisionDate,
    deleted_date: summary.deletedDate,
    login:
      summary.login === null
        ? null
        : {
            username: summary.login.username,
            uris: [...summary.login.uris],
            has_password: summary.login.hasPassword,
            has_totp: summary.login.hasTotp,
          },
    has_notes: summary.hasNotes,
    custom_fields: summary.customFields.map((field) => ({
      name: field.name,
      kind: field.kind,
      value: field.value,
    })),
  };
}

export const folderSchema = z.strictObject({ id: z.string(), name: z.string() });
