/**
 * Statement classification (spec §13.7.2). ACT-36: a statement is tokenised
 * and MUST be exactly one — a `;` outside a string or a comment followed by
 * anything but whitespace is refused. ACT-37: `read` is a statement whose
 * first keyword is `SELECT`, `WITH` or `EXPLAIN` and in which no keyword of
 * the deny set and no `xp_`/`sp_` identifier appears outside a string, a
 * comment or a quoted identifier. ACT-38: `dml`, `ddl`, everything else
 * `other`. Comments never reach the classification because comment tokens
 * are not keywords. This is a control in depth behind the least-privilege
 * login of ACT-85, not a parser that promises to understand every dialect.
 */
import { tokenise, type SqlEngine, type SqlToken } from './tokens.ts';

import type { StatementClass } from '../../policy.ts';

/**
ACT-37: none of these may appear outside a string, comment or quoted identifier in a `read`.
*/
const DENIED: ReadonlySet<string> = new Set([
  'ALTER',
  'BACKUP',
  'CALL',
  'COPY',
  'CREATE',
  'DELETE',
  'DENY',
  'DROP',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'INSERT',
  'INTO',
  'LOCK',
  'MERGE',
  'OPENQUERY',
  'OPENROWSET',
  'RECONFIGURE',
  'RESTORE',
  'REVOKE',
  'SET',
  'SHUTDOWN',
  'TRUNCATE',
  'UPDATE',
  'USE',
  'WAITFOR',
]);

const READ_FIRST: ReadonlySet<string> = new Set(['EXPLAIN', 'SELECT', 'WITH']);
const DML_FIRST: ReadonlySet<string> = new Set(['DELETE', 'INSERT', 'MERGE', 'UPDATE']);
const DDL_FIRST: ReadonlySet<string> = new Set([
  'ALTER',
  'CREATE',
  'DENY',
  'DROP',
  'GRANT',
  'REVOKE',
  'TRUNCATE',
]);

/**
ACT-37: an identifier that names a system or extended stored procedure, whatever surrounds it.
*/
const PROCEDURE_PREFIXES = ['SP_', 'XP_'] as const;

export interface StatementFacts {
  readonly statementClass: StatementClass;
  /**
  The distinct positions the statement binds, ascending (`$1`/`@p1` → 1); ACT-23 checks them.
  */
  readonly positions: readonly number[];
}

/**
ACT-36: a statement that is not exactly one statement has no class, only the `statement_count` refusal.
*/
export type StatementReading =
  | { readonly ok: true; readonly facts: StatementFacts }
  | { readonly ok: false; readonly reason: 'statement_count' };

function keywordsOf(tokens: readonly SqlToken[]): readonly string[] {
  return tokens.filter((token) => token.kind === 'word').map((token) => token.text.toUpperCase());
}

function isProcedureName(keyword: string): boolean {
  return PROCEDURE_PREFIXES.some((prefix) => keyword.startsWith(prefix));
}

function isReadSafe(keywords: readonly string[]): boolean {
  return keywords.every((keyword) => !DENIED.has(keyword) && !isProcedureName(keyword));
}

/**
ACT-37, ACT-38; `WITH … AS (DELETE …) SELECT` leads to a `DELETE`, so it is `dml`, never `read`.
*/
function classOf(keywords: readonly string[]): StatementClass {
  const [first] = keywords;
  if (first === undefined) {
    return 'other';
  }
  if (READ_FIRST.has(first) && isReadSafe(keywords)) {
    return 'read';
  }
  if (DML_FIRST.has(first) || (first === 'WITH' && keywords.some((word) => DML_FIRST.has(word)))) {
    return 'dml';
  }
  return DDL_FIRST.has(first) ? 'ddl' : 'other';
}

/**
ACT-36: anything but whitespace after the first `;` outside a string or comment is a second statement.
*/
function hasSecondStatement(statement: string, tokens: readonly SqlToken[]): boolean {
  const separator = tokens.find((token) => token.kind === 'semicolon');
  return separator !== undefined && statement.slice(separator.end).trim() !== '';
}

function positionsOf(tokens: readonly SqlToken[]): readonly number[] {
  const bound = tokens
    .filter((token) => token.kind === 'placeholder')
    .map((token) => token.position);
  return [...new Set(bound)].toSorted((left, right) => left - right);
}

export function classifyStatement(statement: string, engine: SqlEngine): StatementReading {
  const tokens = tokenise(statement, engine);
  if (hasSecondStatement(statement, tokens)) {
    return { ok: false, reason: 'statement_count' };
  }
  return {
    ok: true,
    facts: { statementClass: classOf(keywordsOf(tokens)), positions: positionsOf(tokens) },
  };
}

/**
 * ACT-23: there is no interpolation path, so the placeholders the statement
 * binds must be exactly `1…n` for `n` parameters. A placeholder without a
 * parameter, a parameter without a placeholder and a gap in the sequence are
 * all `invalid_arguments`.
 */
export function bindingProblem(
  positions: readonly number[],
  count: number,
  engine: SqlEngine,
): string | undefined {
  if (positions.length === count && positions.every((position, at) => position === at + 1)) {
    return undefined;
  }
  const shape = engine === 'postgres' ? '$1…$n' : '@p1…@pn';
  return `params: ${count} parameter(s) need the placeholders ${shape}, each used at least once and none beyond`;
}
