/**
 * MCP-21: the opaque cursor `search_items` hands back so a caller can page through every item a
 * search matches. Items are ordered by id (plain code-unit order, never locale), and the cursor
 * records the last id returned plus the search it belongs to. The next page is the matching items
 * whose id sorts after that one, so paging always terminates, never repeats an item and never
 * skips one that existed for the whole sweep, however the vault changes between pages.
 */
import { z } from 'zod';

const CURSOR_VERSION = 1;

/**
The search a cursor belongs to; a cursor is refused with any other search.
*/
export interface SearchFilters {
  readonly query: string | null;
  readonly type: string | null;
  readonly folder_id: string | null;
  readonly collection_id: string | null;
  readonly url: string | null;
  readonly include_trash: boolean;
}

const cursorSchema = z.strictObject({
  v: z.literal(CURSOR_VERSION),
  after: z.string().min(1),
  filters: z.strictObject({
    query: z.string().nullable(),
    type: z.string().nullable(),
    folder_id: z.string().nullable(),
    collection_id: z.string().nullable(),
    url: z.string().nullable(),
    include_trash: z.boolean(),
  }),
});

/**
The order pages follow: by id, compared code unit by code unit so every runtime agrees.
*/
export function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function encodeCursor(after: string, filters: SearchFilters): string {
  const payload = { v: CURSOR_VERSION, after, filters };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
The id the next page starts after, or undefined when the cursor is malformed or belongs to a
different search.
*/
export function decodeCursor(cursor: string, filters: SearchFilters): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) {
    return undefined;
  }
  return isSameSearch(parsed.data.filters, filters) ? parsed.data.after : undefined;
}

function isSameSearch(left: SearchFilters, right: SearchFilters): boolean {
  return (
    left.query === right.query &&
    left.type === right.type &&
    left.folder_id === right.folder_id &&
    left.collection_id === right.collection_id &&
    left.url === right.url &&
    left.include_trash === right.include_trash
  );
}
