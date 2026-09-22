/**
 * Zod schemas for the `bw serve` Vault Management API (VAULT-12). Every
 * response passes through one of these before any field is read; a shape
 * the schema does not recognise fails closed as `vault_protocol_error`.
 *
 * Objects the client writes back (`item`) are loose so fields vaultgate does
 * not model survive a read-modify-write round trip intact.
 */
import { z } from 'zod';

const nullableString = z.string().nullish();

/**
Every `bw serve` body: `{ success: true, data }` or `{ success: false, message }`.
*/
export const envelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  message: z.string().nullish(),
});

export const messageDataSchema = z.object({
  object: z.literal('message'),
  title: nullableString,
  message: nullableString,
});

export const stringDataSchema = z.object({
  object: z.literal('string'),
  data: z.string(),
});

/**
Shared by `GET /status` (wrapped in a template) and the `bw status` command (bare).
*/
export const statusTemplateSchema = z.object({
  serverUrl: nullableString,
  lastSync: nullableString,
  userEmail: nullableString,
  status: z.enum(['unauthenticated', 'locked', 'unlocked']),
});

export type StatusTemplate = z.output<typeof statusTemplateSchema>;

export const statusDataSchema = z.object({
  object: z.literal('template'),
  template: statusTemplateSchema,
});

export const ITEM_TYPES = {
  login: 1,
  secureNote: 2,
  card: 3,
  identity: 4,
  sshKey: 5,
} as const;

export const FIELD_TYPES = {
  text: 0,
  hidden: 1,
  boolean: 2,
  linked: 3,
} as const;

const itemTypeSchema = z.union([
  z.literal(ITEM_TYPES.login),
  z.literal(ITEM_TYPES.secureNote),
  z.literal(ITEM_TYPES.card),
  z.literal(ITEM_TYPES.identity),
  z.literal(ITEM_TYPES.sshKey),
]);

const fieldTypeSchema = z.union([
  z.literal(FIELD_TYPES.text),
  z.literal(FIELD_TYPES.hidden),
  z.literal(FIELD_TYPES.boolean),
  z.literal(FIELD_TYPES.linked),
]);

const uriSchema = z.looseObject({
  uri: nullableString,
});

const loginSchema = z.looseObject({
  username: nullableString,
  password: nullableString,
  totp: nullableString,
  uris: z.array(uriSchema).nullish(),
});

const fieldSchema = z.looseObject({
  name: nullableString,
  value: nullableString,
  type: fieldTypeSchema,
});

export type RawField = z.output<typeof fieldSchema>;

const cardSchema = z.looseObject({
  number: nullableString,
  code: nullableString,
});

const identitySchema = z.record(z.string(), z.unknown());

const sshKeySchema = z.looseObject({
  privateKey: nullableString,
});

export const itemSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: itemTypeSchema,
  folderId: nullableString,
  organizationId: nullableString,
  collectionIds: z.array(z.string()).nullish(),
  favorite: z.boolean().nullish(),
  revisionDate: z.string(),
  deletedDate: nullableString,
  notes: nullableString,
  login: loginSchema.nullish(),
  card: cardSchema.nullish(),
  identity: identitySchema.nullish(),
  sshKey: sshKeySchema.nullish(),
  fields: z.array(fieldSchema).nullish(),
});

export type RawItem = z.output<typeof itemSchema>;

export const itemListSchema = z.object({
  object: z.literal('list'),
  data: z.array(itemSchema),
});

/**
`bw` lists a pseudo folder named `No Folder` whose id is `""` (current CLIs) or `null` (older ones); the client drops it.
*/
const folderSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
});

export const folderListSchema = z.object({
  object: z.literal('list'),
  data: z.array(folderSchema),
});

const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
});

export const collectionListSchema = z.object({
  object: z.literal('list'),
  data: z.array(collectionSchema),
});
