/**
 * The save-time checks of a target (spec §13.3): the input shape (ACT-1),
 * ACT-3 (every destination host resolves within the private-range rule for
 * the target's `internal` flag), ACT-4 (the vault item exists and reports
 * every mapped field), ACT-57 (plain transport only on an internal target)
 * and the connector's own rules (ACT-35, ACT-81, ACT-88). Every problem is
 * reported at once (ACT-6); nothing connects and nothing reads a secret.
 * The same inspection answers a check that saves nothing (ACT-118), with
 * what each check found: the address each host resolves to, the item's name
 * and whether each mapped field is there.
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

import type {
  AnyConnectorSchemas,
  CredentialField,
  TargetDocuments,
} from './connectors/connector.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { ItemSummary, VaultClient } from '../vault/client.ts';

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

/**
One destination host as a check found it: where a call would connect now, or why it may not.
*/
export interface EndpointReport {
  readonly host: string;
  readonly tls: boolean;
  /**
  The address a call would be pinned to; absent when the host is refused.
  */
  readonly address?: string;
  readonly problems: readonly string[];
}

export type ItemReport =
  | { readonly found: true; readonly name: string }
  | { readonly found: false; readonly problem: string };

export interface FieldReport {
  readonly selector: string;
  readonly role: CredentialField['role'];
  /**
  Why the mapping cannot use this field, or `undefined` when the item carries it.
  */
  readonly problem: string | undefined;
}

export interface CredentialReport {
  readonly item: ItemReport;
  readonly fields: readonly FieldReport[];
}

/**
 * ACT-118: what every save-time check found. `problems` is what a save would
 * refuse, worded as ACT-6 shows it; `rules` those of neither the destination
 * nor the credential (the shape, and the policy's own rules).
 */
export interface CheckReport {
  readonly problems: readonly string[];
  readonly endpoints: readonly EndpointReport[];
  /**
  The item and the fields mapped from it; absent when the documents did not get that far.
  */
  readonly credential?: CredentialReport;
  readonly rules: readonly string[];
}

function fieldReport(item: ItemSummary, field: CredentialField): FieldReport {
  const { selector, role } = field;
  const parsed = parseFieldSelector(selector);
  if (parsed === undefined) {
    return { selector, role, problem: `credential.mapping: "${selector}" is not a field selector` };
  }
  return {
    selector,
    role,
    problem: isFieldPresent(item, parsed)
      ? undefined
      : `credential.mapping: the item has no "${selector}" field`,
  };
}

async function credentialReport(
  vault: VaultClient,
  itemId: string,
  fields: readonly CredentialField[],
): Promise<CredentialReport> {
  const item = await vault.getItem(itemId);
  if (!item.ok) {
    const problem =
      item.error.code === 'not_found'
        ? 'credential.item_id: no such item in the vault'
        : `credential.item_id: the item could not be checked (${item.error.code})`;
    return { item: { found: false, problem }, fields: [] };
  }
  return {
    item: { found: true, name: item.value.name },
    fields: fields.map((field) => fieldReport(item.value, field)),
  };
}

function credentialProblems(credential: CredentialReport): readonly string[] {
  const { item, fields } = credential;
  return item.found
    ? fields.flatMap((field) => (field.problem === undefined ? [] : [field.problem]))
    : [item.problem];
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

async function endpointReports(
  prepared: Prepared,
  lookup: Lookup,
): Promise<readonly EndpointReport[]> {
  const reports: EndpointReport[] = [];
  for (const endpoint of prepared.schemas.endpoints(prepared.documents.destination)) {
    const pinned = await pinEndpoint(endpoint, prepared.changes.internal, lookup);
    const isPlainRefused = !endpoint.tls && !prepared.changes.internal;
    reports.push({
      host: endpoint.host,
      tls: endpoint.tls,
      ...(pinned.ok && { address: pinned.value.address }),
      problems: [
        ...(isPlainRefused
          ? [`destination: plain transport to "${endpoint.host}" needs internal: true`]
          : []),
        ...(pinned.ok ? [] : [`destination: ${pinned.error.message}`]),
      ],
    });
  }
  return reports;
}

interface Inspection {
  readonly report: CheckReport;
  /**
  The validated changes, present only when no check found a problem.
  */
  readonly prepared?: Prepared;
}

/**
The checks stopped before the destination and the credential, by these problems.
*/
function stopped(problems: readonly string[]): Inspection {
  return { report: { problems, endpoints: [], rules: problems } };
}

async function inspect(
  dependencies: CheckDependencies,
  connector: TargetRow['connector'],
  input: unknown,
): Promise<Inspection> {
  const parsed = changesSchema.safeParse(input);
  if (!parsed.success) {
    return stopped(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const changes = parsed.data;
  const documents = parseTargetDocuments(connector, {
    destination: changes.destination,
    credential: changes.credential.mapping,
    policy: changes.policy,
  });
  if (!documents.ok) {
    return stopped(documents.error.problems);
  }
  const { schemas, ...parsedDocuments } = documents.value;
  const prepared: Prepared = { changes, documents: parsedDocuments, schemas };
  const rules = [
    ...schemas.saveProblems(parsedDocuments),
    ...commandProblems(changes.policy, dependencies.allowAnyCommand),
  ];
  const endpoints = await endpointReports(prepared, dependencies.lookup);
  const credential = await credentialReport(
    dependencies.vault,
    changes.credential.item_id,
    schemas.credentialFields(parsedDocuments.credential),
  );
  const problems = [
    ...rules,
    ...endpoints.flatMap((endpoint) => endpoint.problems),
    ...credentialProblems(credential),
  ];
  const report: CheckReport = { problems, endpoints, credential, rules };
  return problems.length > 0 ? { report } : { report, prepared };
}

/**
Every save-time check over the editable fields of a target of the given connector.
*/
export async function prepareChanges(
  dependencies: CheckDependencies,
  connector: TargetRow['connector'],
  input: unknown,
): Promise<Result<Prepared, TargetProblems>> {
  const { report, prepared } = await inspect(dependencies, connector, input);
  return prepared === undefined ? fail(new TargetProblems(report.problems)) : ok(prepared);
}

/**
ACT-118: the same checks with what each found, for a target of `connector`; nothing is written.
*/
export async function checkChanges(
  dependencies: CheckDependencies,
  connector: TargetRow['connector'],
  input: unknown,
): Promise<CheckReport> {
  const { report } = await inspect(dependencies, connector, input);
  return report;
}

/**
ACT-7: the names of the fields an edit changes; the credential document counts as one field.
*/
export function changedFields(before: TargetRow, changes: Changes): readonly string[] {
  return EDITABLE.filter((field) => canonicalJson(before[field]) !== canonicalJson(changes[field]));
}
