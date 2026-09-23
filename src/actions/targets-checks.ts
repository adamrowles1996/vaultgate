/**
 * The save-time checks of a target (spec §13.3): the input shape (ACT-1),
 * ACT-3 (every destination host resolves within the private-range rule for
 * the target's `internal` flag), ACT-4 (the vault item exists and reports
 * every mapped field), ACT-57 (plain transport only on an internal target)
 * and the connector's own rules (ACT-35, ACT-81, ACT-88). Every problem is
 * reported at once (ACT-6); nothing connects and nothing reads a secret.
 */
import { z } from 'zod';

import { fail, ok, type Result } from '../result.ts';
import { isFieldPresent, parseFieldSelector } from '../vault/fields.ts';

import { canonicalJson } from './confirm.ts';
import { pinEndpoint } from './destination.ts';
import { commandPatternProblem } from './policy.ts';
import {
  parseTargetDocuments,
  type TargetInput,
  targetInputSchema,
  TargetProblems,
  type TargetRow,
} from './targets-schemas.ts';

import type { AnyConnectorSchemas, TargetDocuments } from './connectors/connector.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { VaultClient } from '../vault/client.ts';

export interface CheckDependencies {
  readonly vault: VaultClient;
  readonly lookup: Lookup;
  readonly allowAnyCommand: boolean;
}

const EDITABLE = ['description', 'destination', 'internal', 'credential', 'policy'] as const;

/**
The command fields a policy may carry (`ssh`, `winrm`, §14.5, §14.6), read off the operator's input.
*/
const commandPolicySchema = z.object({
  allowed_commands: z.array(z.string()).default([]),
  any_command: z.boolean().default(false),
});

const changesSchema = targetInputSchema.omit({ name: true, connector: true, enabled: true });

/**
What an edit may change; `name` and `connector` are fixed at creation and `enabled` has its own path.
*/
export type Changes = Omit<TargetInput, 'name' | 'connector' | 'enabled'>;

export interface Prepared {
  readonly changes: Changes;
  readonly documents: TargetDocuments<unknown, unknown, unknown>;
  readonly schemas: AnyConnectorSchemas;
}

async function credentialProblems(
  vault: VaultClient,
  itemId: string,
  fields: readonly { readonly selector: string }[],
): Promise<readonly string[]> {
  const item = await vault.getItem(itemId);
  if (!item.ok) {
    return [
      item.error.code === 'not_found'
        ? 'credential.item_id: no such item in the vault'
        : `credential.item_id: the item could not be checked (${item.error.code})`,
    ];
  }
  return fields.flatMap(({ selector }) => {
    const parsed = parseFieldSelector(selector);
    if (parsed === undefined) {
      return [`credential.mapping: "${selector}" is not a field selector`];
    }
    return isFieldPresent(item.value, parsed)
      ? []
      : [`credential.mapping: the item has no "${selector}" field`];
  });
}

/**
 * ACT-35, ACT-88 over any policy that carries command patterns: a pattern
 * that would allow every command is refused unless `any_command` is what
 * the operator means, and `any_command` itself needs the deployment switch.
 */
function commandProblems(policy: unknown, isAnyCommandAllowed: boolean): readonly string[] {
  const parsed = commandPolicySchema.safeParse(policy);
  if (!parsed.success) {
    return ['policy.allowed_commands: must be a list of patterns'];
  }
  const { allowed_commands: patterns, any_command: anyCommand } = parsed.data;
  const open = commandPatternProblem(patterns, anyCommand);
  return [
    ...(anyCommand && !isAnyCommandAllowed
      ? ['policy.any_command: VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND is off on this deployment']
      : []),
    ...(open === undefined ? [] : [`policy.allowed_commands: ${open}`]),
  ];
}

async function destinationProblems(prepared: Prepared, lookup: Lookup): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const endpoint of prepared.schemas.endpoints(prepared.documents.destination)) {
    if (!endpoint.tls && !prepared.changes.internal) {
      problems.push(`destination: plain transport to "${endpoint.host}" needs internal: true`);
    }
    const pinned = await pinEndpoint(endpoint, prepared.changes.internal, lookup);
    if (!pinned.ok) {
      problems.push(`destination: ${pinned.error.message}`);
    }
  }
  return problems;
}

/**
Every save-time check over the editable fields of a target of the given connector.
*/
export async function prepareChanges(
  dependencies: CheckDependencies,
  connector: TargetRow['connector'],
  input: unknown,
): Promise<Result<Prepared, TargetProblems>> {
  const parsed = changesSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      new TargetProblems(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      ),
    );
  }
  const changes = parsed.data;
  const documents = parseTargetDocuments(connector, {
    destination: changes.destination,
    credential: changes.credential.mapping,
    policy: changes.policy,
  });
  if (!documents.ok) {
    return documents;
  }
  const { schemas, ...parsedDocuments } = documents.value;
  const prepared: Prepared = { changes, documents: parsedDocuments, schemas };
  const problems = [
    ...schemas.saveProblems(parsedDocuments),
    ...commandProblems(changes.policy, dependencies.allowAnyCommand),
    ...(await destinationProblems(prepared, dependencies.lookup)),
    ...(await credentialProblems(
      dependencies.vault,
      changes.credential.item_id,
      schemas.credentialFields(parsedDocuments.credential),
    )),
  ];
  return problems.length > 0 ? fail(new TargetProblems(problems)) : ok(prepared);
}

/**
ACT-7: the names of the fields an edit changes; the credential document counts as one field.
*/
export function changedFields(before: TargetRow, changes: Changes): readonly string[] {
  return EDITABLE.filter((field) => canonicalJson(before[field]) !== canonicalJson(changes[field]));
}
