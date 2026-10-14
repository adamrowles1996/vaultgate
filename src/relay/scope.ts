/**
 * Which items the relay answers (RELAY-4) and how a lookup term finds one
 * (RELAY-6). Everything outside the scope is answered exactly as a missing
 * item, so a caller cannot even learn that it exists.
 */
import { ok } from '../result.ts';

import type { ItemSummary, VaultClient, VaultResult } from '../vault/client.ts';

export interface RelayScope {
  /**
  Lower-cased collection ids; an item in any of them is in scope.
  */
  readonly collections: ReadonlySet<string>;
  /**
  Lower-cased item ids in scope whatever their collections.
  */
  readonly items: ReadonlySet<string>;
  /**
  RELAY-12: every live login and secure note, listed or not.
  */
  readonly all: boolean;
}

export type Resolution =
  | { readonly kind: 'one'; readonly item: ItemSummary }
  | { readonly kind: 'none' }
  | { readonly kind: 'many'; readonly ids: readonly string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
How many matches a search reads before the scope filter; the vault returns them all anyway.
*/
const SEARCH_LIMIT = 500;

export function createScope(
  collections: readonly string[],
  items: readonly string[],
  isWholeVault = false,
): RelayScope {
  return {
    collections: new Set(collections.map((id) => id.toLowerCase())),
    items: new Set(items.map((id) => id.toLowerCase())),
    all: isWholeVault,
  };
}

/**
RELAY-4, RELAY-12: a live login or secure note, listed by id, held in a listed collection, or any with the whole-vault scope.
*/
export function isInScope(scope: RelayScope, item: ItemSummary): boolean {
  const isServedType = item.type === 'login' || item.type === 'secureNote';
  const isListed =
    scope.all ||
    scope.items.has(item.id.toLowerCase()) ||
    item.collectionIds.some((id) => scope.collections.has(id.toLowerCase()));
  return item.deletedDate === null && isServedType && isListed;
}

/**
 * RELAY-6: the in-scope items a term names. A UUID reads that one item; any
 * other term is the vault's own search (name, username, URI), filtered to
 * the scope.
 */
export async function findInScope(
  vault: VaultClient,
  scope: RelayScope,
  term: string,
): VaultResult<readonly ItemSummary[]> {
  if (UUID.test(term)) {
    const item = await vault.getItem(term);
    if (!item.ok) {
      return item.error.code === 'not_found' ? ok([]) : item;
    }
    return ok(isInScope(scope, item.value) ? [item.value] : []);
  }
  const found = await vault.searchItems({ text: term, limit: SEARCH_LIMIT });
  return found.ok ? ok(found.value.filter((item) => isInScope(scope, item))) : found;
}

/**
 * RELAY-6: one match answers; several answer the one whose name is the term
 * (ignoring case and surrounding space) when exactly one is, so a caller is
 * not sent to the list route, which would reveal every candidate.
 */
export function resolveOne(term: string, matches: readonly ItemSummary[]): Resolution {
  const [first] = matches;
  if (first === undefined) {
    return { kind: 'none' };
  }
  if (matches.length === 1) {
    return { kind: 'one', item: first };
  }
  const wanted = term.trim().toLowerCase();
  const exact = matches.filter((item) => item.name.trim().toLowerCase() === wanted);
  const [only] = exact;
  return only !== undefined && exact.length === 1
    ? { kind: 'one', item: only }
    : { kind: 'many', ids: matches.map((item) => item.id) };
}
