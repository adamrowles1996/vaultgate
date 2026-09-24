/**
 * What the engine lends a connector for the duration of one run
 * (`RunSupport`, §14.1): a second host resolved under the ACT-55 rules, a
 * secret obtained mid-call added to the call's scrub table (ACT-51), and the
 * credential rotation of ACT-83 — the one path by which the actions layer
 * writes to the vault. The connector never holds the vault client, the
 * resolver or the audit sink itself.
 */
import { fail, ok, type Result } from '../result.ts';
import { parseFieldSelector, type FieldSelector } from '../vault/fields.ts';

import { pinEndpoint } from './destination.ts';
import { ActionError } from './errors.ts';

import type { Endpoint, PinnedEndpoint, RunSupport } from './connectors/connector.ts';
import type { SecretHolder } from './secrets.ts';
import type { TargetRow } from './targets-schemas.ts';
import type { AuditSink } from '../audit/event.ts';
import type { Logger } from '../logger.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { ItemPatch, VaultClient } from '../vault/client.ts';

export interface SupportDependencies {
  readonly vault: VaultClient;
  readonly lookup: Lookup;
  readonly audit: AuditSink;
  readonly logger: Logger;
}

/**
 * The `ItemPatch` that writes one field, or `undefined` for a selector the
 * vault contract cannot write: a rotated credential belongs in a hidden
 * custom field, the login password or the notes, and nowhere else.
 */
function patchFor(selector: FieldSelector, value: string): ItemPatch | undefined {
  switch (selector.kind) {
    case 'customField': {
      return { customFields: [{ name: selector.name, value }] };
    }
    case 'password': {
      return { login: { password: value } };
    }
    case 'notes': {
      return { notes: value };
    }
    default: {
      return undefined;
    }
  }
}

async function rotate(
  dependencies: SupportDependencies,
  row: TargetRow,
  field: string,
  value: string,
): Promise<Result<void, ActionError>> {
  const selector = parseFieldSelector(field);
  const patch = selector === undefined ? undefined : patchFor(selector, value);
  const failed = (reason: string): Result<never, ActionError> => {
    dependencies.logger.warn({ target: row.name, field, reason }, 'credential rotation failed');
    return fail(new ActionError('credential_rotation_failed', { reason }));
  };
  if (patch === undefined) {
    return failed('unwritable_field');
  }
  const written = await dependencies.vault.updateItem(row.credential.item_id, patch);
  if (!written.ok) {
    return failed(written.error.code);
  }
  // ACT-83: the target, the item and the field, never the value.
  dependencies.audit.record({
    category: 'actions',
    action: 'credential_rotated',
    outcome: 'ok',
    itemId: row.credential.item_id,
    field,
    details: { target: row.name, connector: row.connector },
  });
  return ok(undefined);
}

async function resolve(
  dependencies: SupportDependencies,
  row: TargetRow,
  endpoint: Endpoint,
): Promise<Result<PinnedEndpoint, ActionError>> {
  const pinned = await pinEndpoint(endpoint, row.internal, dependencies.lookup);
  if (pinned.ok) {
    return pinned;
  }
  const code = pinned.error.problem === 'unresolved' ? 'connection_failed' : 'destination_refused';
  return fail(new ActionError(code, { reason: pinned.error.problem }));
}

export function createRunSupport(
  dependencies: SupportDependencies,
  row: TargetRow,
  secrets: SecretHolder,
): RunSupport {
  return {
    target: { id: row.id, name: row.name, revision: row.revision },
    resolve: (endpoint) => resolve(dependencies, row, endpoint),
    capture: (field, value) => {
      secrets.add({ field, value });
    },
    rotate: (field, value) => rotate(dependencies, row, field, value),
    scrub: (text) => secrets.scrub.text(text),
  };
}
