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

describe('line comments', () => {
  const ENGINES = ['mssql', 'postgres'] as const;

  it.each(ENGINES)(
    'ACT-36 %s: a -- comment ends at a bare carriage return, so what follows is a second statement',
    (engine) => {
      expect(classifyStatement('SELECT 1 --x\r; DROP TABLE audit_log', engine)).toStrictEqual({
        ok: false,
        reason: 'statement_count',
      });
      expect(classifyStatement('SELECT 1 --x\n; DROP TABLE audit_log', engine)).toStrictEqual({
        ok: false,
        reason: 'statement_count',
      });
    },
  );

  it.each(ENGINES)(
    'ACT-36 %s: a -- comment with no line terminator still runs to the end of the statement',
    (engine) => {
      expect(classifyStatement('SELECT 1 -- ; DROP TABLE audit_log', engine)).toStrictEqual({
        ok: true,
        facts: { statementClass: 'read', positions: [] },
      });
    },
  );

  it.each(ENGINES)(
    'ACT-37 %s: DBCC, WRITETEXT, UPDATETEXT and READTEXT are denied in a read',
    (engine) => {
      const denied = [
        'DBCC CHECKDB',
        'WRITETEXT t.c @ptr N',
        'UPDATETEXT t.c @ptr 0 0',
        'READTEXT t.c @ptr 0 1',
      ];
      for (const tail of denied) {
        const reading = classifyStatement(`SELECT * FROM t WHERE x = (${tail})`, engine);
        expect(reading.ok && reading.facts.statementClass).toBe('other');
      }
    },
  );
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
