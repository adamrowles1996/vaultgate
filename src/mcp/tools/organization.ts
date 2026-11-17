/**
 * Writing items into an organisation (MCP-19, MCP-20). The agent names a
 * collection; vaultgate finds its organisation in `list_collections` and
 * writes there only when the operator lists that organisation in
 * `VAULTGATE_WRITE_ORGANIZATIONS`. Which shared space an agent may add to is
 * the operator's decision, never the agent's.
 */
import { z } from 'zod';

import { fail, ok, type Result } from '../../result.ts';
import { VaultError } from '../../vault/client.ts';

import {
  defineTool,
  type Tool,
  ToolError,
  type ToolFailure,
  type ToolRun,
  type ToolSettings,
  WRITE,
} from './definition.ts';
import { itemIdSchema, itemSummarySchema, toItemSummaryOutput } from './schemas.ts';

import type { Collection, VaultClient } from '../../vault/client.ts';

export const collectionIdSchema = z
  .string()
  .min(1)
  .describe('The collection id, as returned by list_collections.');

/**
 * MCP-19: the collection `collectionId` names, provided the account can see
 * it (`not_found` otherwise) and its organisation is one the operator lets
 * items be written into (`policy_denied` otherwise).
 */
export async function writableCollection(
  vault: VaultClient,
  settings: ToolSettings,
  collectionId: string,
): Promise<Result<Collection, ToolFailure>> {
  const collections = await vault.listCollections();
  if (!collections.ok) {
    return collections;
  }
  const wanted = collectionId.toLowerCase();
  const collection = collections.value.find((candidate) => candidate.id.toLowerCase() === wanted);
  if (collection === undefined) {
    return fail(new VaultError('not_found', 'no collection with that id'));
  }
  return settings.writeOrganizations.includes(collection.organizationId.toLowerCase())
    ? ok(collection)
    : fail(
        new ToolError(
          'policy_denied',
          "the collection's organisation is not one the operator lets items be written into",
        ),
      );
}

const moveInput = z.strictObject({ item_id: itemIdSchema, collection_id: collectionIdSchema });
const moveOutput = z.strictObject({ item: itemSummarySchema });

/**
MCP-20: only an item still in the account's own vault, and not trashed, can be moved.
*/
async function movableItem(vault: VaultClient, id: string): Promise<Result<string, ToolFailure>> {
  const item = await vault.getItem(id);
  if (!item.ok) {
    return item;
  }
  if (item.value.organizationId !== null) {
    return fail(new ToolError('item_in_organization', 'the item is already in an organisation'));
  }
  return item.value.deletedDate === null
    ? ok(item.value.id)
    : fail(new ToolError('item_in_trash', 'the item is in the trash'));
}

const runMove: ToolRun<typeof moveInput, typeof moveOutput> = async (vault, input, settings) => {
  const collection = await writableCollection(vault, settings, input.collection_id);
  if (!collection.ok) {
    return collection;
  }
  const item = await movableItem(vault, input.item_id);
  if (!item.ok) {
    return item;
  }
  const moved = await vault.moveItem(item.value, collection.value);
  return moved.ok ? ok({ item: toItemSummaryOutput(moved.value) }) : moved;
};

export const toolMoveItemToCollection: Tool = defineTool({
  name: 'move_item_to_collection',
  description:
    "Moves one item from the account's own vault into an organisation collection (Bitwarden's " +
    '"move to organisation") and returns its summary with organization_id and collection_ids; ' +
    'never a secret value. Use list_collections for a collection_id. Refused with ' +
    "policy_denied when the operator does not let items be written into the collection's " +
    'organisation, item_in_organization when the item is already in one, and item_in_trash ' +
    'for a trashed item. A moved item cannot be moved back with vaultgate.',
  annotations: { ...WRITE, title: 'Move item to collection' },
  inputSchema: moveInput,
  outputSchema: moveOutput,
  auditReference: (input) => ({ itemId: input.item_id }),
  run: runMove,
});
