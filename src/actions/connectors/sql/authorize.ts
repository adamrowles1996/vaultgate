/**
 * The pure half of the `sql` connector (ACT-78): the policy decision of
 * ACT-39 over a `sql_query` or a `sql_execute`. The statement must be exactly
 * one (ACT-36) and must classify (ACT-37, ACT-38) as what the tool serves —
 * `sql_query` only ever reads, whatever the statement is, and `sql_execute`
 * takes `dml`, `ddl` when `write_classes` allows it, and then the
 * `statement_allowlist` if the target carries one. Classification happens
 * here, before the credential is fetched and long before a connection is
 * opened (ACT-26). No I/O.
 */
import { isPatternMatch } from '../../policy.ts';
import { excerptOf } from '../operation-summary.ts';

import { classifyStatement } from './classify.ts';
import { SQL_QUERY_TOOL } from './operation.ts';

import type { SqlOperation } from './operation.ts';
import type { SqlCredential, SqlDestination, SqlPolicy } from './schemas.ts';
import type { PolicyDecision, StatementClass } from '../../policy.ts';
import type { OperationDescription, OperationRequest, TargetCapabilities } from '../connector.ts';

export type SqlRequest = OperationRequest<SqlDestination, SqlCredential, SqlPolicy>;

function isWriteClass(statementClass: StatementClass): statementClass is 'ddl' | 'dml' {
  return statementClass === 'ddl' || statementClass === 'dml';
}

/**
ACT-34: the patterns are matched against the statement as the agent wrote it, newline by newline.
*/
function isStatementAllowed(patterns: readonly string[], statement: string): boolean {
  return (
    patterns.length === 0 ||
    patterns.some((pattern) => isPatternMatch(pattern, statement, 'command'))
  );
}

/**
ACT-37: `sql_query` accepts the `read` class and nothing else, whatever scopes the token holds.
*/
function readDecision(policy: SqlPolicy, statementClass: StatementClass): PolicyDecision {
  if (!policy.operations.includes('read')) {
    return { allowed: false, reason: 'operation' };
  }
  return statementClass === 'read'
    ? { allowed: true, operation: 'read', class: 'read' }
    : { allowed: false, reason: 'statement_class' };
}

/**
ACT-38: `dml`, then `ddl` only when `write_classes` says so, then the `statement_allowlist`.
*/
function writeDecision(
  policy: SqlPolicy,
  statementClass: StatementClass,
  statement: string,
): PolicyDecision {
  if (!policy.operations.includes('write')) {
    return { allowed: false, reason: 'operation' };
  }
  if (!isWriteClass(statementClass) || !policy.write_classes.includes(statementClass)) {
    return { allowed: false, reason: 'statement_class' };
  }
  return isStatementAllowed(policy.statement_allowlist, statement)
    ? { allowed: true, operation: 'write', class: statementClass }
    : { allowed: false, reason: 'statement_pattern' };
}

export function authorize(request: SqlRequest, operation: SqlOperation): PolicyDecision {
  const reading = classifyStatement(operation.statement, request.destination.engine);
  if (!reading.ok) {
    return { allowed: false, reason: reading.reason };
  }
  const { statementClass } = reading.facts;
  return request.tool === SQL_QUERY_TOOL
    ? readDecision(request.policy, statementClass)
    : writeDecision(request.policy, statementClass, operation.statement);
}

/**
ACT-43: the statement as the agent wrote it, excerpted and never silently; ACT-60: the class the engine audits.
*/
export function describeOperation(
  request: SqlRequest,
  operation: SqlOperation,
): OperationDescription {
  const reading = classifyStatement(operation.statement, request.destination.engine);
  return {
    ...excerptOf(operation.statement),
    classification: reading.ok ? reading.facts.statementClass : 'other',
  };
}

/**
 * ACT-19: the operations the policy allows, each with the scope a token needs
 * to reach it, and the `engine` that tells an agent which dialect and which
 * placeholders to write.
 */
export function capabilities(destination: SqlDestination, policy: SqlPolicy): TargetCapabilities {
  return {
    operations: policy.operations.map((operation) => ({
      operation,
      scope: operation === 'read' ? ('actions:sql.read' as const) : ('actions:sql.write' as const),
    })),
    engine: destination.engine,
  };
}
