/**
 * The ACT-77 corpus: every comment and string trick the SQL classifier has to
 * see through, per engine, and every keyword of ACT-37's deny set that a
 * `read` may not contain. `classify.test.ts` turns each entry into one named
 * test.
 */
import type { SqlEngine } from '../actions/connectors/sql/tokens.ts';

export type Verdict = 'ddl' | 'dml' | 'other' | 'read' | 'statement_count';

export interface Entry {
  readonly engine: SqlEngine;
  readonly what: string;
  readonly statement: string;
  readonly verdict: Verdict;
}

export const SQL_CORPUS: readonly Entry[] = [
  {
    engine: 'postgres',
    what: 'SELECT 1; DROP TABLE x is two statements',
    statement: 'SELECT 1; DROP TABLE x',
    verdict: 'statement_count',
  },
  {
    engine: 'mssql',
    what: 'SELECT 1; DROP TABLE x is two statements',
    statement: 'SELECT 1; DROP TABLE x',
    verdict: 'statement_count',
  },
  {
    engine: 'postgres',
    what: "a semicolon inside 'a string' does not separate statements",
    statement: "SELECT 'a; DROP TABLE x' FROM t",
    verdict: 'read',
  },
  {
    engine: 'mssql',
    what: "a semicolon inside N'a string' does not separate statements",
    statement: "SELECT N'a; DROP TABLE x' FROM t",
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'a doubled quote inside a string does not end it',
    statement: "SELECT * FROM t WHERE name = 'a''; DROP TABLE x'",
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'block comments around the separator do not hide a second statement',
    statement: 'SELECT/**/1/**/;/**/DROP TABLE x',
    verdict: 'statement_count',
  },
  {
    engine: 'postgres',
    what: 'a line comment after the separator is still a second statement',
    statement: 'SELECT 1; -- done',
    verdict: 'statement_count',
  },
  {
    engine: 'postgres',
    what: 'a trailing separator with only whitespace after it is one statement',
    statement: 'SELECT 1;   \n  ',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'a leading comment is stripped before the first keyword is read',
    statement: '-- reporting\n/* daily */ SELECT 1',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'block comments nest, so an inner close does not end the outer comment',
    statement: '/* /* DROP TABLE x */ */ SELECT 1',
    verdict: 'read',
  },
  {
    engine: 'mssql',
    what: 'block comments do not nest, so the first close ends the comment',
    statement: '/* /* */ DROP TABLE x */ SELECT 1',
    verdict: 'ddl',
  },
  {
    engine: 'postgres',
    what: 'a $$ dollar-quoted body containing DELETE is a string, not a keyword',
    statement: 'SELECT $$ DELETE FROM t $$ AS body',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'a $tag$ dollar-quoted body containing a separator is one statement',
    statement: 'DO $body$ BEGIN DELETE FROM t; END $body$',
    verdict: 'other',
  },
  {
    engine: 'mssql',
    what: 'dollar quoting is PostgreSQL only, so $$ DELETE $$ is a DELETE keyword',
    statement: 'SELECT $$ DELETE FROM t $$ AS body',
    verdict: 'other',
  },
  {
    engine: 'postgres',
    what: "an E'…' literal honours a backslash escape, so the quote inside does not end it",
    statement: String.raw`SELECT E'\'; DROP TABLE t' AS x`,
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: "a doubled quote inside an E'…' literal does not end it either",
    statement: "SELECT E'it''s ; DROP TABLE x' AS x",
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: "an unterminated E'…' literal swallows the rest",
    statement: "SELECT E'oops ; DROP TABLE x",
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'SELECT … INTO creates a table, so INTO is denied',
    statement: 'SELECT * INTO backup FROM t',
    verdict: 'other',
  },
  {
    engine: 'postgres',
    what: 'WITH … AS (DELETE …) SELECT leads to a DELETE, so it is dml, not read',
    statement: 'WITH removed AS (DELETE FROM t RETURNING *) SELECT * FROM removed',
    verdict: 'dml',
  },
  {
    engine: 'postgres',
    what: 'WITH … AS (SELECT …) SELECT is read',
    statement: 'WITH recent AS (SELECT 1 AS n) SELECT n FROM recent',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'EXEC inside a string is not the EXEC keyword',
    statement: "SELECT 'EXEC sp_who' AS instruction",
    verdict: 'read',
  },
  {
    engine: 'mssql',
    what: 'EXEC as the first keyword is not read',
    statement: 'EXEC sp_who',
    verdict: 'other',
  },
  {
    engine: 'mssql',
    what: 'an identifier beginning with sp_ is refused wherever it appears',
    statement: 'SELECT * FROM sp_helptext',
    verdict: 'other',
  },
  {
    engine: 'mssql',
    what: 'an identifier beginning with xp_ is refused wherever it appears',
    statement: "EXEC xp_cmdshell 'dir'",
    verdict: 'other',
  },
  {
    engine: 'mssql',
    what: '"INSERT" as a quoted identifier is allowed',
    statement: 'SELECT "INSERT" FROM t',
    verdict: 'read',
  },
  {
    engine: 'mssql',
    what: '[INSERT] as a bracket-quoted identifier is allowed',
    statement: 'SELECT [INSERT] FROM [dbo].[orders]',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: '"INSERT" as a quoted identifier is allowed',
    statement: 'SELECT "INSERT" FROM t',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'a bracket is a subscript, not a quoted identifier, so a separator after one still counts',
    statement: 'SELECT a[1]; DROP TABLE x',
    verdict: 'statement_count',
  },
  {
    engine: 'postgres',
    what: 'keywords are matched case-insensitively, so lower-case select is read',
    statement: 'select 1',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'EXPLAIN SELECT is read',
    statement: 'EXPLAIN SELECT 1',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'EXPLAIN ANALYZE DELETE executes the DELETE, so it is not read',
    statement: 'EXPLAIN ANALYZE DELETE FROM t',
    verdict: 'other',
  },
  {
    engine: 'postgres',
    what: 'COPY is not read',
    statement: "COPY t FROM '/tmp/x'",
    verdict: 'other',
  },
  { engine: 'postgres', what: 'LOCK is not read', statement: 'LOCK TABLE t', verdict: 'other' },
  {
    engine: 'postgres',
    what: 'SET is not read',
    statement: 'SET search_path = public',
    verdict: 'other',
  },
  { engine: 'mssql', what: 'USE is not read', statement: 'USE master', verdict: 'other' },
  {
    engine: 'mssql',
    what: 'WAITFOR is not read',
    statement: "WAITFOR DELAY '00:00:10'",
    verdict: 'other',
  },
  {
    engine: 'mssql',
    what: 'OPENROWSET is not read',
    statement: "SELECT * FROM OPENROWSET('a', 'b', 'c')",
    verdict: 'other',
  },
  {
    engine: 'postgres',
    what: 'INSERT is dml',
    statement: 'INSERT INTO t VALUES (1)',
    verdict: 'dml',
  },
  {
    engine: 'postgres',
    what: 'MERGE is dml',
    statement: 'MERGE INTO t USING s ON 1=1',
    verdict: 'dml',
  },
  {
    engine: 'postgres',
    what: 'CREATE is ddl',
    statement: 'CREATE TABLE t (a int)',
    verdict: 'ddl',
  },
  { engine: 'postgres', what: 'TRUNCATE is ddl', statement: 'TRUNCATE t', verdict: 'ddl' },
  {
    engine: 'postgres',
    what: 'GRANT is ddl',
    statement: 'GRANT SELECT ON t TO reader',
    verdict: 'ddl',
  },
  {
    engine: 'postgres',
    what: 'a statement with no keyword at all is other',
    statement: '42',
    verdict: 'other',
  },
  {
    engine: 'postgres',
    what: 'an unterminated literal swallows the rest, so nothing after it is a second statement',
    statement: "SELECT 'oops; DROP TABLE x",
    verdict: 'read',
  },
  {
    engine: 'mssql',
    what: 'an unterminated bracket identifier swallows the rest the same way',
    statement: 'SELECT [a; DROP TABLE x',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'an unterminated block comment swallows the rest',
    statement: 'SELECT 1 /* ; DROP TABLE x',
    verdict: 'read',
  },
  {
    engine: 'postgres',
    what: 'an unterminated dollar-quoted body swallows the rest',
    statement: 'SELECT $tag$ ; DROP TABLE x',
    verdict: 'read',
  },
];
