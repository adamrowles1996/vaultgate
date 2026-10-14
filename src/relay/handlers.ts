/**
 * The relay's read routes (RELAY-5), each audited (RELAY-8). A handler
 * receives a caller the admission check already accepted and answers in
 * `bw serve`'s envelope. Nothing here writes to the vault: `/sync` is
 * acknowledged without touching it, because the vault already syncs on its
 * own schedule (VAULT-9) and a caller must not be able to drive it.
 */
import { type ItemBody, revealItem, revealScalar, type ScalarKind } from './item-body.ts';
import {
  ambiguous,
  failure,
  NOT_FOUND,
  type RelayReply,
  stringReply,
  success,
  vaultFailure,
} from './responses.ts';
import { findInScope, type RelayScope, resolveOne } from './scope.ts';

import type { AuditDetails, AuditOutcome, AuditSink } from '../audit/event.ts';
import type { ItemSummary, VaultClient, VaultError } from '../vault/client.ts';

export interface Caller {
  /**
  The node's MagicDNS name (RELAY-3).
  */
  readonly node: string;
  readonly ip: string;
}

export interface HandlerDependencies {
  readonly vault: VaultClient;
  readonly scope: RelayScope;
  readonly audit: AuditSink;
}

/**
The longest lookup or search term accepted; item names are far shorter.
*/
export const MAX_TERM_LENGTH = 200;

/**
The most items one list answer reveals; a broader search must be narrowed.
*/
export const MAX_LIST_ITEMS = 20;

interface Recorded {
  readonly outcome: AuditOutcome;
  readonly itemId?: string;
  readonly field?: string;
  readonly details?: AuditDetails;
}

function record(
  dependencies: HandlerDependencies,
  caller: Caller,
  action: string,
  event: Recorded,
): void {
  dependencies.audit.record({
    category: 'relay',
    action: `relay.${action}`,
    outcome: event.outcome,
    itemId: event.itemId,
    field: event.field,
    ip: caller.ip,
    details: { node: caller.node, ...event.details },
  });
}

function failed(error: VaultError): AuditOutcome {
  return `error:${error.code}`;
}

/**
The term itself, or the reply refusing it: absent, blank or longer than `MAX_TERM_LENGTH`.
*/
function checkedTerm(term: string | undefined): string | RelayReply {
  if (term === undefined || term.trim().length === 0) {
    return failure(400, 'A search term is required.');
  }
  return term.length > MAX_TERM_LENGTH ? failure(400, 'The search term is too long.') : term;
}

export async function handleStatus(
  dependencies: HandlerDependencies,
  caller: Caller,
): Promise<RelayReply> {
  const status = await dependencies.vault.status();
  if (!status.ok) {
    record(dependencies, caller, 'status', { outcome: failed(status.error) });
    return vaultFailure(status.error);
  }
  const { state, lastSyncAt } = status.value;
  record(dependencies, caller, 'status', { outcome: 'ok', details: { state } });
  if (state === 'unavailable') {
    return failure(503, 'Vault is unavailable.');
  }
  // RELAY-10: the lock state only; never the server or the account.
  return success({
    object: 'template',
    template: { serverUrl: null, lastSync: lastSyncAt, userEmail: null, status: state },
  });
}

export function handleSync(dependencies: HandlerDependencies, caller: Caller): RelayReply {
  record(dependencies, caller, 'sync', { outcome: 'ok' });
  return success({ object: 'message', title: 'Syncing complete.', message: null });
}

/**
The one in-scope item `term` names, or the reply that says why there is none.
*/
async function lookUp(
  dependencies: HandlerDependencies,
  caller: Caller,
  action: string,
  requested: string,
): Promise<ItemSummary | RelayReply> {
  const term = checkedTerm(requested);
  if (typeof term !== 'string') {
    record(dependencies, caller, action, { outcome: 'failure', details: { reason: 'term' } });
    return term;
  }
  const matches = await findInScope(dependencies.vault, dependencies.scope, term);
  if (!matches.ok) {
    record(dependencies, caller, action, { outcome: failed(matches.error) });
    return vaultFailure(matches.error);
  }
  const resolution = resolveOne(term, matches.value);
  if (resolution.kind === 'one') {
    return resolution.item;
  }
  const reason = resolution.kind === 'none' ? 'not_found' : 'ambiguous';
  record(dependencies, caller, action, { outcome: 'failure', details: { reason, term } });
  return resolution.kind === 'none' ? NOT_FOUND : ambiguous(resolution.ids);
}

function isReply(value: ItemSummary | RelayReply): value is RelayReply {
  return 'status' in value;
}

export async function handleItem(
  dependencies: HandlerDependencies,
  caller: Caller,
  term: string,
): Promise<RelayReply> {
  const item = await lookUp(dependencies, caller, 'item', term);
  if (isReply(item)) {
    return item;
  }
  const body = await revealItem(dependencies.vault, item);
  record(dependencies, caller, 'item', {
    outcome: body.ok ? 'ok' : failed(body.error),
    itemId: item.id,
  });
  return body.ok ? success(body.value) : vaultFailure(body.error);
}

export async function handleScalar(
  dependencies: HandlerDependencies,
  caller: Caller,
  kind: ScalarKind,
  term: string,
): Promise<RelayReply> {
  const item = await lookUp(dependencies, caller, 'secret', term);
  if (isReply(item)) {
    return item;
  }
  const value = await revealScalar(dependencies.vault, item, kind);
  record(dependencies, caller, 'secret', {
    outcome: value.ok ? 'ok' : failed(value.error),
    itemId: item.id,
    field: kind,
  });
  return value.ok ? stringReply(value.value) : vaultFailure(value.error);
}

/**
RELAY-6: every in-scope match of a search, revealed, capped at `MAX_LIST_ITEMS`.
*/
export async function handleList(
  dependencies: HandlerDependencies,
  caller: Caller,
  requested: string | undefined,
): Promise<RelayReply> {
  const search = checkedTerm(requested);
  if (typeof search !== 'string') {
    record(dependencies, caller, 'list', { outcome: 'failure', details: { reason: 'term' } });
    return search;
  }
  const matches = await findInScope(dependencies.vault, dependencies.scope, search);
  if (!matches.ok) {
    record(dependencies, caller, 'list', { outcome: failed(matches.error) });
    return vaultFailure(matches.error);
  }
  if (matches.value.length > MAX_LIST_ITEMS) {
    record(dependencies, caller, 'list', { outcome: 'failure', details: { reason: 'too_many' } });
    return failure(400, 'Too many results; search more narrowly.');
  }
  return revealAll(dependencies, caller, search, matches.value);
}

async function revealAll(
  dependencies: HandlerDependencies,
  caller: Caller,
  search: string,
  items: readonly ItemSummary[],
): Promise<RelayReply> {
  const bodies: ItemBody[] = [];
  for (const item of items) {
    const body = await revealItem(dependencies.vault, item);
    if (!body.ok) {
      record(dependencies, caller, 'list', { outcome: failed(body.error), itemId: item.id });
      return vaultFailure(body.error);
    }
    record(dependencies, caller, 'list', { outcome: 'ok', itemId: item.id });
    bodies.push(body.value);
  }
  if (items.length === 0) {
    record(dependencies, caller, 'list', { outcome: 'ok', details: { results: 0, term: search } });
  }
  return success({ object: 'list', data: bodies });
}
