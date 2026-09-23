/**
 * The pure half of the `sql` connector (ACT-78): the policy decision of
 * ACT-39 over a `sql_query` — the target must allow the `read` operation,
 * the statement must be exactly one (ACT-36) and must classify as `read`
 * (ACT-37) — the ACT-43 summary with the ACT-60 classification, and the
 * ACT-19 capabilities. Classification happens here, before the credential
 * is fetched and long before a connection is opened (ACT-26). No I/O.
 */
import { classifyStatement } from './classify.ts';

import type { SqlOperation } from './operation.ts';
import type { SqlDestination, SqlPolicy } from './schemas.ts';
import type { PolicyDecision } from '../../policy.ts';
import type { OperationDescription, TargetCapabilities } from '../connector.ts';

const SUMMARY_CAP = 1024;

export function authorize(
  policy: SqlPolicy,
  operation: SqlOperation,
  _credential: unknown,
  destination: SqlDestination,
): PolicyDecision {
  if (!policy.operations.includes('read')) {
    return { allowed: false, reason: 'operation' };
  }
  const reading = classifyStatement(operation.statement, destination.engine);
  if (!reading.ok) {
    return { allowed: false, reason: reading.reason };
  }
  return reading.facts.statementClass === 'read'
    ? { allowed: true, operation: 'read', class: 'read' }
    : { allowed: false, reason: 'statement_class' };
}

/**
ACT-43: the statement as the agent wrote it, capped; ACT-60: the class the engine audits.
*/
export function describeOperation(
  operation: SqlOperation,
  destination: SqlDestination,
): OperationDescription {
  const reading = classifyStatement(operation.statement, destination.engine);
  return {
    summary: operation.statement.slice(0, SUMMARY_CAP),
    classification: reading.ok ? reading.facts.statementClass : 'other',
  };
}

/**
 * ACT-19: `sql_query` is the only tool this build serves, so only the `read`
 * operation is reachable; the `engine` tells an agent which dialect and which
 * placeholders to write.
 */
export function capabilities(destination: SqlDestination, policy: SqlPolicy): TargetCapabilities {
  return {
    operations: policy.operations
      .filter((operation) => operation === 'read')
      .map((operation) => ({ operation, scope: 'actions:sql.read' as const })),
    engine: destination.engine,
  };
}
