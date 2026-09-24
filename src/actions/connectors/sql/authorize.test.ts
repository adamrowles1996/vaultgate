import { describe, expect, it } from 'vitest';

import { authorize, capabilities, describeOperation, type SqlRequest } from './authorize.ts';
import { SQL_EXECUTE_TOOL, SQL_QUERY_TOOL, sqlOperationSchema } from './operation.ts';
import { sqlCredentialSchema, sqlDestinationSchema, sqlPolicySchema } from './schemas.ts';

import type { SqlDestination, SqlPolicy } from './schemas.ts';
import type { PolicyDecision } from '../../policy.ts';

const CREDENTIAL = sqlCredentialSchema.parse({});
const WRITES = { operations: ['read', 'write'] } as const;

function destination(engine: SqlDestination['engine'] = 'postgres'): SqlDestination {
  return sqlDestinationSchema.parse({ engine, host: 'db.example.com', database: 'reporting' });
}

function policy(overrides: Readonly<Record<string, unknown>> = {}): SqlPolicy {
  return sqlPolicySchema.parse(overrides);
}

function request(
  tool: string,
  overrides: Readonly<Record<string, unknown>> = {},
  engine: SqlDestination['engine'] = 'postgres',
): SqlRequest {
  return {
    tool,
    destination: destination(engine),
    credential: CREDENTIAL,
    policy: policy(overrides),
  };
}

function decide(
  tool: string,
  statement: string,
  overrides: Readonly<Record<string, unknown>> = {},
): PolicyDecision {
  return authorize(request(tool, overrides), sqlOperationSchema.parse({ statement }));
}

describe('the sql policy decision for sql_query', () => {
  it('ACT-39 ACT-37 allows a read statement on a target that allows the read operation', () => {
    expect(decide(SQL_QUERY_TOOL, 'SELECT 1')).toStrictEqual({
      allowed: true,
      operation: 'read',
      class: 'read',
    });
  });

  it('ACT-39 refuses with reason operation when the policy does not allow read', () => {
    expect(decide(SQL_QUERY_TOOL, 'SELECT 1', { operations: ['write'] })).toStrictEqual({
      allowed: false,
      reason: 'operation',
    });
  });

  it('ACT-36 ACT-39 refuses with reason statement_count when more than one statement is given', () => {
    expect(decide(SQL_QUERY_TOOL, 'SELECT 1; DROP TABLE x')).toStrictEqual({
      allowed: false,
      reason: 'statement_count',
    });
  });

  it('ACT-37 ACT-39 refuses a writing statement even on a target that allows write', () => {
    expect(decide(SQL_QUERY_TOOL, 'DELETE FROM t', WRITES)).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
  });

  it('ACT-36 classification follows the destination engine, not the tool', () => {
    const operation = sqlOperationSchema.parse({ statement: 'SELECT $$ DELETE FROM t $$ AS body' });
    expect(authorize(request(SQL_QUERY_TOOL), operation)).toMatchObject({ allowed: true });
    expect(authorize(request(SQL_QUERY_TOOL, {}, 'mssql'), operation)).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
  });
});

describe('the sql policy decision for sql_execute', () => {
  it('ACT-25 ACT-38 ACT-40 allows a dml statement as a write on a target that allows it', () => {
    expect(decide(SQL_EXECUTE_TOOL, 'UPDATE t SET a = 1', WRITES)).toStrictEqual({
      allowed: true,
      operation: 'write',
      class: 'dml',
    });
  });

  it('ACT-39 refuses with reason operation when the policy allows read only', () => {
    expect(decide(SQL_EXECUTE_TOOL, 'UPDATE t SET a = 1')).toStrictEqual({
      allowed: false,
      reason: 'operation',
    });
  });

  it('ACT-38 refuses a read statement: it belongs in sql_query', () => {
    expect(decide(SQL_EXECUTE_TOOL, 'SELECT 1', WRITES)).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
  });

  it('ACT-38 refuses a statement that is neither dml nor ddl', () => {
    expect(decide(SQL_EXECUTE_TOOL, 'SET search_path = public', WRITES)).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
  });

  it('ACT-38 refuses ddl until write_classes names it, then allows it', () => {
    expect(decide(SQL_EXECUTE_TOOL, 'DROP TABLE t', WRITES)).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
    expect(
      decide(SQL_EXECUTE_TOOL, 'DROP TABLE t', { ...WRITES, write_classes: ['dml', 'ddl'] }),
    ).toStrictEqual({ allowed: true, operation: 'write', class: 'ddl' });
  });

  it('ACT-36 ACT-34 a bare carriage return does not smuggle a second statement past the classifier or the allowlist', () => {
    const smuggled = 'DELETE FROM sessions WHERE id = 1 --\r; DROP TABLE customers';
    expect(decide(SQL_EXECUTE_TOOL, smuggled, WRITES)).toStrictEqual({
      allowed: false,
      reason: 'statement_count',
    });
    expect(
      decide(SQL_EXECUTE_TOOL, smuggled, {
        ...WRITES,
        statement_allowlist: ['DELETE FROM sessions WHERE *'],
      }),
    ).toStrictEqual({ allowed: false, reason: 'statement_count' });
  });

  it('ACT-23 refuses a statement holding a NUL byte or another control character but tab, CR and LF', () => {
    expect(sqlOperationSchema.safeParse({ statement: 'SELECT 1\u{0} 2' }).success).toBe(false);
    expect(sqlOperationSchema.safeParse({ statement: 'SELECT 1\u{1B}[0m' }).success).toBe(false);
    expect(sqlOperationSchema.safeParse({ statement: 'SELECT\t1\r\n FROM t' }).success).toBe(true);
  });

  it('ACT-38 a write_classes of ddl only refuses dml', () => {
    const only = { ...WRITES, write_classes: ['ddl'] };
    expect(decide(SQL_EXECUTE_TOOL, 'DELETE FROM t', only)).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
    expect(decide(SQL_EXECUTE_TOOL, 'TRUNCATE t', only)).toMatchObject({ allowed: true });
  });

  it('ACT-34 ACT-39 applies the statement_allowlist after the class, with reason statement_pattern', () => {
    const allowlisted = {
      ...WRITES,
      statement_allowlist: ['UPDATE orders SET status = $1 WHERE id = $2'],
    };
    expect(
      decide(SQL_EXECUTE_TOOL, 'UPDATE orders SET status = $1 WHERE id = $2', allowlisted),
    ).toMatchObject({ allowed: true, class: 'dml' });
    expect(decide(SQL_EXECUTE_TOOL, 'UPDATE orders SET status = 1', allowlisted)).toStrictEqual({
      allowed: false,
      reason: 'statement_pattern',
    });
  });

  it('ACT-34 a star in a statement pattern matches within one line only', () => {
    const allowlisted = { ...WRITES, statement_allowlist: ['DELETE FROM sessions WHERE *'] };
    expect(
      decide(SQL_EXECUTE_TOOL, 'DELETE FROM sessions WHERE id = 1', allowlisted),
    ).toMatchObject({ allowed: true });
    expect(
      decide(SQL_EXECUTE_TOOL, 'DELETE FROM sessions WHERE id = 1\nOR id = 2', allowlisted),
    ).toStrictEqual({ allowed: false, reason: 'statement_pattern' });
  });

  it('ACT-36 refuses a second statement before the class or the allowlist is consulted', () => {
    expect(
      decide(SQL_EXECUTE_TOOL, 'DELETE FROM t; DROP TABLE x', {
        ...WRITES,
        statement_allowlist: ['**'],
      }),
    ).toStrictEqual({ allowed: false, reason: 'statement_count' });
  });
});

describe('describing a sql operation', () => {
  it('ACT-43 ACT-60 summarises the statement and classifies it for the audit trail', () => {
    expect(
      describeOperation(
        request(SQL_EXECUTE_TOOL),
        sqlOperationSchema.parse({ statement: 'DELETE FROM t' }),
      ),
    ).toStrictEqual({ summary: 'DELETE FROM t', classification: 'dml' });
  });

  it('ACT-43 excerpts a long statement head and tail rather than hiding its end', () => {
    const statement = `SELECT '${'a'.repeat(4000)}' FROM audit_log`;
    const described = describeOperation(
      request(SQL_QUERY_TOOL),
      sqlOperationSchema.parse({ statement }),
    );
    expect(described.summary).toHaveLength(768 + 3 + 192);
    expect(described.summary.endsWith('FROM audit_log')).toBe(true);
    expect(described.omitted).toMatchObject({
      characters: statement.length - 960,
      total: statement.length,
    });
  });

  it('ACT-60 a statement with no single class is audited as other', () => {
    expect(
      describeOperation(
        request(SQL_QUERY_TOOL),
        sqlOperationSchema.parse({ statement: 'SELECT 1; DROP TABLE x' }),
      ).classification,
    ).toBe('other');
  });
});

describe('what actions_list_targets may say about a sql target', () => {
  it('ACT-19 reports the read operation with the sql.read scope and the engine', () => {
    expect(capabilities(destination('mssql'), policy())).toStrictEqual({
      operations: [{ operation: 'read', scope: 'actions:sql.read' }],
      engine: 'mssql',
    });
  });

  it('ACT-19 reports write with the sql.write scope when the policy allows it', () => {
    expect(capabilities(destination(), policy(WRITES))).toStrictEqual({
      operations: [
        { operation: 'read', scope: 'actions:sql.read' },
        { operation: 'write', scope: 'actions:sql.write' },
      ],
      engine: 'postgres',
    });
  });
});
