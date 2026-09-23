import { describe, expect, it } from 'vitest';

import { sqlExecuteTool, sqlOperationSchema, sqlQueryTool } from './operation.ts';

function problems(input: Readonly<Record<string, unknown>>): readonly string[] {
  const parsed = sqlOperationSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('the sql_query arguments', () => {
  it('ACT-23 defaults params to none and keeps the statement as written', () => {
    expect(sqlOperationSchema.parse({ statement: 'SELECT 1' })).toStrictEqual({
      statement: 'SELECT 1',
      params: [],
    });
  });

  it('ACT-23 refuses a statement over 64 KiB', () => {
    expect(problems({ statement: 'a'.repeat(64 * 1024 + 1) })).toStrictEqual([
      'must be at most 64 KiB',
    ]);
    expect(problems({ statement: 'a'.repeat(64 * 1024) })).toStrictEqual([]);
  });

  it('ACT-23 refuses an empty statement and more than 100 parameters', () => {
    expect(problems({ statement: '' })).toHaveLength(1);
    expect(
      problems({ statement: 'SELECT 1', params: Array.from({ length: 101 }, () => 1) }),
    ).toHaveLength(1);
  });

  it('ACT-23 refuses a parameter that is not a JSON scalar', () => {
    expect(problems({ statement: 'SELECT $1', params: [{ a: 1 }] })).toHaveLength(1);
  });

  it('ACT-15 the tool is strict about anything else in the arguments', () => {
    expect(problems({ statement: 'SELECT 1', rowMode: 'array' })).toHaveLength(1);
  });

  it('ACT-23 both tools take the same arguments, and each needs its own scope', () => {
    expect(sqlExecuteTool.inputSchema).toBe(sqlQueryTool.inputSchema);
    expect(sqlQueryTool.scope).toBe('actions:sql.read');
    expect(sqlExecuteTool.scope).toBe('actions:sql.write');
  });

  it('ACT-18 sql_query is annotated read-only and sql_execute destructive', () => {
    expect(sqlQueryTool.annotations).toStrictEqual({
      title: 'SQL query',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(sqlExecuteTool.annotations).toStrictEqual({
      title: 'SQL execute',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});
