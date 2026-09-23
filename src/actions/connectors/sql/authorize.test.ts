import { describe, expect, it } from 'vitest';

import { authorize, capabilities, describeOperation } from './authorize.ts';
import { sqlQuerySchema } from './operation.ts';
import { sqlCredentialSchema, sqlDestinationSchema, sqlPolicySchema } from './schemas.ts';

import type { SqlDestination, SqlPolicy } from './schemas.ts';

const CREDENTIAL = sqlCredentialSchema.parse({});

function destination(engine: SqlDestination['engine'] = 'postgres'): SqlDestination {
  return sqlDestinationSchema.parse({ engine, host: 'db.example.com', database: 'reporting' });
}

function policy(overrides: Readonly<Record<string, unknown>> = {}): SqlPolicy {
  return sqlPolicySchema.parse(overrides);
}

function decide(statement: string, overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return authorize(
    policy(overrides),
    sqlQuerySchema.parse({ statement }),
    CREDENTIAL,
    destination(),
  );
}

describe('the sql policy decision', () => {
  it('ACT-39 ACT-37 allows a read statement on a target that allows the read operation', () => {
    expect(decide('SELECT 1')).toStrictEqual({ allowed: true, operation: 'read', class: 'read' });
  });

  it('ACT-39 refuses with reason operation when the policy does not allow read', () => {
    expect(decide('SELECT 1', { operations: ['write'] })).toStrictEqual({
      allowed: false,
      reason: 'operation',
    });
  });

  it('ACT-36 ACT-39 refuses with reason statement_count when more than one statement is given', () => {
    expect(decide('SELECT 1; DROP TABLE x')).toStrictEqual({
      allowed: false,
      reason: 'statement_count',
    });
  });

  it('ACT-37 ACT-39 refuses with reason statement_class when the statement is not a read', () => {
    expect(decide('DELETE FROM t')).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
  });

  it('ACT-36 classification follows the destination engine, not the tool', () => {
    const operation = sqlQuerySchema.parse({ statement: 'SELECT $$ DELETE FROM t $$ AS body' });
    expect(authorize(policy(), operation, CREDENTIAL, destination('postgres'))).toMatchObject({
      allowed: true,
    });
    expect(authorize(policy(), operation, CREDENTIAL, destination('mssql'))).toStrictEqual({
      allowed: false,
      reason: 'statement_class',
    });
  });
});

describe('describing a sql operation', () => {
  it('ACT-43 ACT-60 summarises the statement and classifies it for the audit trail', () => {
    expect(
      describeOperation(sqlQuerySchema.parse({ statement: 'SELECT 1' }), destination()),
    ).toStrictEqual({ summary: 'SELECT 1', classification: 'read' });
  });

  it('ACT-43 caps the summary at 1 KiB', () => {
    const statement = `SELECT '${'a'.repeat(4000)}'`;
    const described = describeOperation(sqlQuerySchema.parse({ statement }), destination());
    expect(described.summary).toHaveLength(1024);
  });

  it('ACT-60 a statement with no single class is audited as other', () => {
    expect(
      describeOperation(
        sqlQuerySchema.parse({ statement: 'SELECT 1; DROP TABLE x' }),
        destination(),
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

  it('ACT-19 does not report write until sql_execute serves it', () => {
    expect(capabilities(destination(), policy({ operations: ['read', 'write'] }))).toStrictEqual({
      operations: [{ operation: 'read', scope: 'actions:sql.read' }],
      engine: 'postgres',
    });
  });
});
