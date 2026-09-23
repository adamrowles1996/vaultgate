import { describe, expect, it } from 'vitest';

import { SQL_CORPUS } from '../../../test-support/sql-corpus.ts';

import { bindingProblem, classifyStatement } from './classify.ts';

import type { Verdict } from '../../../test-support/sql-corpus.ts';

describe('the sql statement classifier', () => {
  for (const entry of SQL_CORPUS) {
    it(`ACT-77 ACT-36 ACT-37 ACT-38 ${entry.engine}: ${entry.what}`, () => {
      const reading = classifyStatement(entry.statement, entry.engine);
      const verdict: Verdict = reading.ok ? reading.facts.statementClass : reading.reason;
      expect(verdict).toBe(entry.verdict);
    });
  }
});

describe('placeholders', () => {
  it('ACT-23 counts $n on PostgreSQL, once per distinct position, ignoring dollar-quoted bodies', () => {
    const reading = classifyStatement('SELECT $$ $9 $$, $2, $1 FROM t WHERE a = $1', 'postgres');
    expect(reading).toStrictEqual({
      ok: true,
      facts: { statementClass: 'read', positions: [1, 2] },
    });
  });

  it('ACT-23 counts @pn on SQL Server and leaves other variables alone', () => {
    const reading = classifyStatement('SELECT @@ROWCOUNT, @p2, @p1, @other', 'mssql');
    expect(reading).toStrictEqual({
      ok: true,
      facts: { statementClass: 'read', positions: [1, 2] },
    });
  });

  it('ACT-23 a $ that opens neither a placeholder nor a dollar-quoted body is just a character', () => {
    const reading = classifyStatement('SELECT $ FROM t', 'postgres');
    expect(reading).toStrictEqual({ ok: true, facts: { statementClass: 'read', positions: [] } });
  });

  it('ACT-23 accepts exactly the placeholders the parameters bind', () => {
    expect(bindingProblem([1, 2], 2, 'postgres')).toBeUndefined();
    expect(bindingProblem([], 0, 'mssql')).toBeUndefined();
  });

  it('ACT-23 refuses a placeholder without a parameter', () => {
    expect(bindingProblem([1, 2], 1, 'postgres')).toContain('$1…$n');
  });

  it('ACT-23 refuses a parameter without a placeholder', () => {
    expect(bindingProblem([1], 2, 'mssql')).toContain('@p1…@pn');
  });

  it('ACT-23 refuses a gap in the sequence', () => {
    expect(bindingProblem([1, 3], 2, 'postgres')).toContain('2 parameter(s)');
  });
});
