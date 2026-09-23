/**
 * The target row (spec §13.3.1, ACT-1): the common fields as zod, the
 * connector-specific documents validated through the schema registry, and
 * the validated or invalid shape everything else consumes. A row is
 * validated on write and again on read; a stored row that fails is reported
 * as `invalid` and refuses every call with `target_invalid`.
 */
import { z } from 'zod';

import { CONNECTOR_KINDS, type ConnectorKind } from '../config/actions.ts';
import { fail, ok, type Result } from '../result.ts';

import { schemasFor } from './connectors/registry.ts';
import { type CommonPolicy, commonPolicySchema } from './policy.ts';

import type { AnyConnectorSchemas } from './connectors/connector.ts';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DESCRIPTION = 200;

export const targetNameSchema = z
  .string()
  .regex(
    NAME_PATTERN,
    'must be 1 to 63 lower-case letters, digits or hyphens, starting with a letter or digit',
  );

/**
What the operator submits for a new target or an edit (§13.3.1); `name` and `connector` are fixed after creation.
*/
export const targetInputSchema = z.strictObject({
  name: targetNameSchema,
  description: z.string().max(MAX_DESCRIPTION).default(''),
  connector: z.enum(CONNECTOR_KINDS),
  destination: z.unknown(),
  internal: z.boolean().default(false),
  credential: z.strictObject({ item_id: z.string().min(1), mapping: z.unknown() }),
  policy: z.unknown(),
  enabled: z.boolean().default(true),
});

export type TargetInput = z.output<typeof targetInputSchema>;

export interface TargetCredential {
  readonly item_id: string;
  readonly mapping: unknown;
}

export interface TargetRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly connector: ConnectorKind;
  readonly destination: unknown;
  readonly internal: boolean;
  readonly credential: TargetCredential;
  readonly policy: unknown;
  readonly enabled: boolean;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/**
The three documents after their connector schemas, with the common policy fields parsed out.
*/
export interface TargetDocuments {
  readonly destination: unknown;
  readonly credential: unknown;
  readonly policy: unknown;
  readonly common: CommonPolicy;
}

export type ValidatedTarget =
  | {
      readonly state: 'valid';
      readonly row: TargetRow;
      readonly documents: TargetDocuments;
      readonly schemas: AnyConnectorSchemas;
    }
  | { readonly state: 'invalid'; readonly row: TargetRow; readonly problems: readonly string[] };

export class TargetProblems extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'TargetProblems';
    this.problems = problems;
  }
}

function issues(prefix: string, parsed: z.ZodSafeParseResult<unknown>): readonly string[] {
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${[prefix, ...issue.path.map(String)].join('.')}: ${issue.message}`,
      );
}

/**
 * Validates the connector-specific documents of a row or an input against
 * the connector's schemas (ACT-1); every problem is reported, not just the
 * first.
 */
export function parseTargetDocuments(
  connector: ConnectorKind,
  documents: Pick<TargetDocuments, 'destination' | 'credential' | 'policy'>,
): Result<TargetDocuments & { readonly schemas: AnyConnectorSchemas }, TargetProblems> {
  const schemas = schemasFor(connector);
  if (schemas === undefined) {
    return fail(new TargetProblems([`connector: ${connector} is not available in this build`]));
  }
  const destination = schemas.destinationSchema.safeParse(documents.destination);
  const credential = schemas.credentialSchema.safeParse(documents.credential);
  const policy = schemas.policySchema.safeParse(documents.policy);
  if (!destination.success || !credential.success || !policy.success) {
    return fail(
      new TargetProblems([
        ...issues('destination', destination),
        ...issues('credential.mapping', credential),
        ...issues('policy', policy),
      ]),
    );
  }
  // Every connector policy schema extends the common one, so this cannot fail.
  const common = commonPolicySchema.parse(policy.data);
  return ok({
    destination: destination.data,
    credential: credential.data,
    policy: policy.data,
    common,
    schemas,
  });
}

/**
A stored row as the engine and the pages see it: valid with its parsed documents, or invalid with the reasons.
*/
export function validateTarget(row: TargetRow): ValidatedTarget {
  const parsed = parseTargetDocuments(row.connector, {
    destination: row.destination,
    credential: row.credential.mapping,
    policy: row.policy,
  });
  if (!parsed.ok) {
    return { state: 'invalid', row, problems: parsed.error.problems };
  }
  const { schemas, ...documents } = parsed.value;
  return { state: 'valid', row, documents, schemas };
}
