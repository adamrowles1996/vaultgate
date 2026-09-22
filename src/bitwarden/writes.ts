/**
 * Write operations with read-after-write consistency (VAULT-10): after a
 * create, update or trash, the item is polled until the new revision is
 * readable, bounded to five seconds. No sync is triggered.
 */
import { z } from 'zod';

import { ok, type Result } from '../result.ts';

import { type Clock, sleep } from './clock.ts';
import { newItemBody, patchedItemBody, summariseItem } from './items.ts';
import { itemPath } from './requests.ts';
import { itemSchema, type RawItem } from './types.ts';

import type { BwServeApi } from './api.ts';
import type { Folder, ItemPatch, ItemSummary, NewItem, VaultError } from '../vault/client.ts';

const READ_AFTER_WRITE_BUDGET_MS = 5000;
const READ_AFTER_WRITE_POLL_MS = 100;

const createdFolderSchema = z.object({ id: z.string(), name: z.string() });
const anyDataSchema = z.unknown();

export interface WriteContext {
  readonly api: BwServeApi;
  readonly clock: Clock;
}

type RawResult = Promise<Result<RawItem, VaultError>>;

function readItem(api: BwServeApi, id: string): RawResult {
  return api.call({ method: 'GET', path: itemPath(id), schema: itemSchema });
}

function isSettled(
  current: Result<RawItem, VaultError>,
  isVisible: (item: RawItem) => boolean,
): boolean {
  return current.ok ? isVisible(current.value) : current.error.code !== 'not_found';
}

/**
 * Polls the item until `isVisible` holds or the budget elapses. A `not_found`
 * counts as "not visible yet" (a just-created item). On timeout the last
 * observation is returned rather than an error: the write itself succeeded.
 */
async function awaitRevision(
  { api, clock }: WriteContext,
  id: string,
  isVisible: (item: RawItem) => boolean,
): RawResult {
  const deadline = clock.now() + READ_AFTER_WRITE_BUDGET_MS;
  for (;;) {
    const current = await readItem(api, id);
    if (isSettled(current, isVisible) || clock.now() >= deadline) {
      return current;
    }
    await sleep(clock, READ_AFTER_WRITE_POLL_MS).done;
  }
}

async function summariseWhenVisible(
  context: WriteContext,
  written: RawItem,
): Promise<Result<ItemSummary, VaultError>> {
  const visible = await awaitRevision(
    context,
    written.id,
    (raw) => raw.revisionDate === written.revisionDate,
  );
  return visible.ok ? ok(summariseItem(visible.value)) : visible;
}

export async function createItem(
  context: WriteContext,
  item: NewItem,
): Promise<Result<ItemSummary, VaultError>> {
  const created = await context.api.call({
    method: 'POST',
    path: '/object/item',
    body: newItemBody(item),
    schema: itemSchema,
    rejectedCode: 'invalid_item',
  });
  return created.ok ? summariseWhenVisible(context, created.value) : created;
}

export async function updateItem(
  context: WriteContext,
  id: string,
  patch: ItemPatch,
): Promise<Result<ItemSummary, VaultError>> {
  const before = await readItem(context.api, id);
  if (!before.ok) {
    return before;
  }
  const updated = await context.api.call({
    method: 'PUT',
    path: itemPath(id),
    body: patchedItemBody(before.value, patch),
    schema: itemSchema,
    rejectedCode: 'invalid_item',
  });
  return updated.ok ? summariseWhenVisible(context, updated.value) : updated;
}

export async function trashItem(
  context: WriteContext,
  id: string,
): Promise<Result<void, VaultError>> {
  const deleted = await context.api.call({
    method: 'DELETE',
    path: itemPath(id),
    schema: anyDataSchema,
    rejectedCode: 'invalid_item',
  });
  if (!deleted.ok) {
    return deleted;
  }
  const visible = await awaitRevision(context, id, (raw) => raw.deletedDate != null);
  return visible.ok ? ok(undefined) : visible;
}

export function createFolder(api: BwServeApi, name: string): Promise<Result<Folder, VaultError>> {
  return api.call({
    method: 'POST',
    path: '/object/folder',
    body: { name },
    schema: createdFolderSchema,
    rejectedCode: 'invalid_item',
  });
}
