import { describe, expect, it } from 'vitest';

import { InMemoryVaultClient } from '../../test-support/in-memory-vault-client.ts';
import { failureCode, runOk } from '../../test-support/run-tool.ts';
import { CANARIES, FIXTURE_ITEMS, type StoredItem } from '../../test-support/vault-fixture.ts';

import { toolSearchItems, toolVaultStatus } from './read.ts';
import { encodeCursor } from './search-cursor.ts';

function fixtureLogin(): StoredItem {
  const [login] = FIXTURE_ITEMS;
  if (login === undefined) {
    throw new Error('fixture has no items');
  }
  return login;
}

const TEMPLATE = fixtureLogin();

/**
Ids compared as MCP-21 orders them.
*/
function byId(left: string, right: string): number {
  return left < right ? -1 : 1;
}

/**
A stored item copied from the fixture login (secrets and all), under a new id.
*/
function itemWithId(id: string, isTrashed = false): StoredItem {
  return {
    summary: {
      ...TEMPLATE.summary,
      id,
      name: `Item ${id}`,
      deletedDate: isTrashed ? '2026-11-01T00:00:00.000Z' : null,
    },
    secrets: TEMPLATE.secrets,
  };
}

/**
`count` ids, inserted out of id order so a page boundary cannot come from insertion order.
*/
function scrambledIds(count: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // 7919 is prime, so this visits every index once in a scrambled order.
    const scrambled = (index * 7919) % count;
    ids.push(`id-${String(scrambled).padStart(4, '0')}`);
  }
  return ids;
}

interface Page {
  readonly ids: string[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly text: string;
}

async function page(vault: InMemoryVaultClient, input: Record<string, unknown>): Promise<Page> {
  const output = await runOk(toolSearchItems, vault, input);
  return {
    ids: (output['items'] as { id: string }[]).map((item) => item.id),
    truncated: output['truncated'] as boolean,
    nextCursor: output['next_cursor'] as string | null,
    text: JSON.stringify(output),
  };
}

/**
Follows next_cursor until the last page, returning every page; fails rather than looping forever.
*/
async function sweep(
  vault: InMemoryVaultClient,
  input: Record<string, unknown>,
  maxPages = 1000,
): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const next = await page(vault, cursor === null ? input : { ...input, cursor });
    pages.push(next);
    cursor = next.nextCursor;
    if (pages.length > maxPages) {
      throw new Error('paging did not terminate');
    }
  } while (cursor !== null);
  return pages;
}

describe('MCP-21 search_items paging', () => {
  it('MCP-21 pages through every item exactly once, in id order, matching vault_status', async () => {
    const ids = scrambledIds(237);
    const vault = new InMemoryVaultClient([
      ...ids.map((id) => itemWithId(id)),
      itemWithId('id-trashed', true),
    ]);
    const pages = await sweep(vault, { limit: 100 });
    expect(pages.map((each) => each.ids.length)).toStrictEqual([100, 100, 37]);
    expect(pages.map((each) => each.truncated)).toStrictEqual([true, true, false]);
    const seen = pages.flatMap((each) => each.ids);
    expect(seen).toStrictEqual(ids.toSorted(byId));
    expect(new Set(seen).size).toBe(237);
    const status = await runOk(toolVaultStatus, vault, {});
    expect(status['item_count']).toBe(seen.length);
    for (const each of pages) {
      expect(CANARIES.filter((canary) => each.text.includes(canary))).toStrictEqual([]);
    }
  });

  it('MCP-21 pages the trash and filters too, with the default page of 50', async () => {
    const vault = new InMemoryVaultClient([
      ...scrambledIds(60).map((id) => itemWithId(id)),
      itemWithId('id-trashed', true),
    ]);
    const all = await sweep(vault, { include_trash: true });
    expect(all.map((each) => each.ids.length)).toStrictEqual([50, 11]);
    expect(all.flatMap((each) => each.ids)).toContain('id-trashed');
    const filtered = await sweep(vault, { query: 'Item id-000', limit: 3 });
    expect(filtered.flatMap((each) => each.ids)).toStrictEqual(scrambledIds(10).toSorted(byId));
  });

  it('MCP-21 a cursor from a changed vault terminates without repeating or skipping a lasting item', async () => {
    const before = scrambledIds(120);
    const first = await page(new InMemoryVaultClient(before.map((id) => itemWithId(id))), {
      limit: 40,
    });
    expect(first.ids).toStrictEqual(before.toSorted(byId).slice(0, 40));
    const removed = new Set(['id-0050', 'id-0003']);
    const changed = [
      ...before.filter((id) => !removed.has(id)),
      'id-0000a', // added before the cursor: not returned, it did not exist throughout
      'id-0119a', // added after the cursor: returned
    ];
    const rest = await sweep(new InMemoryVaultClient(changed.map((id) => itemWithId(id))), {
      limit: 40,
      cursor: first.nextCursor,
    });
    const seen = [...first.ids, ...rest.flatMap((each) => each.ids)];
    expect(new Set(seen).size).toBe(seen.length);
    const lasting = before.filter((id) => !removed.has(id));
    expect(lasting.filter((id) => !seen.includes(id))).toStrictEqual([]);
    expect(seen).toContain('id-0119a');
    expect(seen).not.toContain('id-0000a');
    expect(seen).not.toContain('id-0050');
  });

  it('MCP-21 an empty search is one empty last page', async () => {
    const result = await page(new InMemoryVaultClient([]), {});
    expect(result).toMatchObject({ ids: [], truncated: false, nextCursor: null });
  });

  it('MCP-21 refuses a cursor that is malformed or belongs to another search', async () => {
    const vault = new InMemoryVaultClient(scrambledIds(10).map((id) => itemWithId(id)));
    const first = await page(vault, { limit: 3 });
    expect(await failureCode(toolSearchItems, vault, { cursor: 'not-a-cursor' })).toBe(
      'invalid_cursor',
    );
    expect(
      await failureCode(toolSearchItems, vault, { cursor: first.nextCursor, query: 'Item' }),
    ).toBe('invalid_cursor');
    expect(
      await failureCode(toolSearchItems, vault, {
        cursor: first.nextCursor,
        include_trash: true,
      }),
    ).toBe('invalid_cursor');
    const foreign = Buffer.from(JSON.stringify({ v: 2, after: 'id-0001' }), 'utf8').toString(
      'base64url',
    );
    expect(await failureCode(toolSearchItems, vault, { cursor: foreign })).toBe('invalid_cursor');
  });

  it('MCP-21 a cursor carries only an item id and the search, never item data', () => {
    const cursor = encodeCursor('id-0001', {
      query: 'db',
      type: null,
      folder_id: null,
      collection_id: null,
      url: null,
      include_trash: false,
    });
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toStrictEqual({
      v: 1,
      after: 'id-0001',
      filters: {
        query: 'db',
        type: null,
        folder_id: null,
        collection_id: null,
        url: null,
        include_trash: false,
      },
    });
  });
});
