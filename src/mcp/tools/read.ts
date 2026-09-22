/**
 * `vault:read` tools (spec §06.2): metadata only, never a secret value.
 */
import { z } from 'zod';

import { ok } from '../../result.ts';

import { defineTool, READ_ONLY, type Tool, type ToolRun } from './definition.ts';
import {
  folderSchema,
  itemIdSchema,
  itemSummarySchema,
  itemTypeSchema,
  LOCK_STATES,
  toItemSummaryOutput,
} from './schemas.ts';

const SEARCH_CAP = 50;
/**
Upper bound when counting items for `vault_status`; a personal vault is far smaller.
*/
const COUNT_BOUND = 100_000;

const statusOutput = z.strictObject({
  server_url: z.string(),
  user_email_masked: z.string().nullable(),
  state: z.enum(LOCK_STATES),
  last_sync_at: z.string().nullable(),
  item_count: z.number().int().nonnegative(),
});

const runVaultStatus: ToolRun<z.ZodObject, typeof statusOutput> = async (vault) => {
  const status = await vault.status();
  if (!status.ok) {
    return status;
  }
  const items = await vault.searchItems({ limit: COUNT_BOUND });
  if (!items.ok) {
    return items;
  }
  return ok({
    server_url: status.value.serverUrl,
    user_email_masked: status.value.userEmailMasked,
    state: status.value.state,
    last_sync_at: status.value.lastSyncAt,
    item_count: items.value.length,
  });
};

export const toolVaultStatus: Tool = defineTool({
  name: 'vault_status',
  description:
    'Reports the vault connection: server URL, the account e-mail with its local part masked, ' +
    'the lock state, the last sync time and the number of items not in the trash. Returns no item ' +
    'data and no secrets. Call it first if another tool reports vault_unavailable.',
  annotations: { ...READ_ONLY, title: 'Vault status' },
  inputSchema: z.strictObject({}),
  outputSchema: statusOutput,
  run: runVaultStatus,
});

const searchInput = z.strictObject({
  query: z.string().optional().describe('Free-text search; omit to filter only.'),
  type: itemTypeSchema.optional(),
  folder_id: z.string().optional(),
  collection_id: z.string().optional(),
  url: z.string().optional().describe('Match login items whose URIs contain this text.'),
  include_trash: z.boolean().default(false),
  limit: z.number().int().min(1).max(SEARCH_CAP).default(SEARCH_CAP),
});

const searchOutput = z.strictObject({
  items: z.array(itemSummarySchema),
  truncated: z.boolean().describe('True when the limit cut the result set short.'),
});

const runSearchItems: ToolRun<typeof searchInput, typeof searchOutput> = async (vault, input) => {
  const result = await vault.searchItems({
    ...(input.query !== undefined && { text: input.query }),
    ...(input.type !== undefined && { type: input.type }),
    ...(input.folder_id !== undefined && { folderId: input.folder_id }),
    ...(input.collection_id !== undefined && { collectionId: input.collection_id }),
    ...(input.url !== undefined && { url: input.url }),
    includeTrash: input.include_trash,
    limit: input.limit + 1,
  });
  if (!result.ok) {
    return result;
  }
  const items = result.value.slice(0, input.limit).map((item) => toItemSummaryOutput(item));
  return ok({ items, truncated: result.value.length > input.limit });
};

export const toolSearchItems: Tool = defineTool({
  name: 'search_items',
  description:
    'Finds vault items by free text (matched against name, username and URIs) with optional filters. ' +
    'Returns at most 50 item summaries: id, name, type, username, URIs, folder, favourite flag and ' +
    'revision date. Never returns passwords, notes or other secret values; use get_secret with an ' +
    'item id from these results to read one secret field. Narrow the query rather than paging.',
  annotations: { ...READ_ONLY, title: 'Search items' },
  inputSchema: searchInput,
  outputSchema: searchOutput,
  run: runSearchItems,
});

const presence = z.strictObject({ present: z.boolean() });

const itemLookupInput = z.strictObject({ item_id: itemIdSchema });

const secretsPresence = z.strictObject({
  password: presence,
  totp: presence,
  notes: presence,
  card: presence,
  identity: presence,
  ssh_private_key: presence,
  hidden_fields: z
    .array(z.string())
    .describe('Names of hidden custom fields readable via get_secret.'),
});

const itemLookupOutput = z.strictObject({ item: itemSummarySchema, secrets: secretsPresence });

const runGetItem: ToolRun<typeof itemLookupInput, typeof itemLookupOutput> = async (
  vault,
  input,
) => {
  const result = await vault.getItem(input.item_id);
  if (!result.ok) {
    return result;
  }
  const item = result.value;
  const hiddenFields = item.customFields.filter((field) => field.kind === 'hidden');
  return ok({
    item: toItemSummaryOutput(item),
    secrets: {
      password: { present: item.login?.hasPassword ?? false },
      totp: { present: item.login?.hasTotp ?? false },
      notes: { present: item.hasNotes },
      card: { present: item.type === 'card' },
      identity: { present: item.type === 'identity' },
      ssh_private_key: { present: item.type === 'sshKey' },
      hidden_fields: hiddenFields.map((field) => field.name),
    },
  });
};

export const toolGetItem: Tool = defineTool({
  name: 'get_item',
  description:
    'Returns one item’s metadata by id: name, type, username, URIs, folder, collections, ' +
    'favourite flag, dates and custom field names. Secret fields (password, TOTP, notes, card ' +
    'number and code, identity fields, SSH private key, hidden custom fields) are reported only ' +
    'as present or absent; call get_secret to read a value. Use search_items first if you do not ' +
    'have an item id.',
  annotations: { ...READ_ONLY, title: 'Get item' },
  inputSchema: itemLookupInput,
  outputSchema: itemLookupOutput,
  auditReference: (input) => ({ itemId: input.item_id }),
  run: runGetItem,
});

const foldersOutput = z.strictObject({ folders: z.array(folderSchema) });

const runListFolders: ToolRun<z.ZodObject, typeof foldersOutput> = async (vault) => {
  const result = await vault.listFolders();
  return result.ok
    ? ok({ folders: result.value.map((folder) => ({ id: folder.id, name: folder.name })) })
    : result;
};

export const toolListFolders: Tool = defineTool({
  name: 'list_folders',
  description:
    'Lists every folder as id and name. Use a folder id with search_items (folder_id) or with ' +
    'create_item and update_item. Returns no items and no secrets.',
  annotations: { ...READ_ONLY, title: 'List folders' },
  inputSchema: z.strictObject({}),
  outputSchema: foldersOutput,
  run: runListFolders,
});

const collectionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  organization_id: z.string(),
});
const collectionsOutput = z.strictObject({ collections: z.array(collectionSchema) });

const runListCollections: ToolRun<z.ZodObject, typeof collectionsOutput> = async (vault) => {
  const result = await vault.listCollections();
  if (!result.ok) {
    return result;
  }
  const collections = result.value.map((collection) => ({
    id: collection.id,
    name: collection.name,
    organization_id: collection.organizationId,
  }));
  return ok({ collections });
};

export const toolListCollections: Tool = defineTool({
  name: 'list_collections',
  description:
    'Lists the organisation collections the account can see: id, name and organisation id. Use a ' +
    'collection id with search_items (collection_id). Returns no items and no secrets.',
  annotations: { ...READ_ONLY, title: 'List collections' },
  inputSchema: z.strictObject({}),
  outputSchema: collectionsOutput,
  run: runListCollections,
});
