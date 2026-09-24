import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { caller, errorOf, resultOf, storedCalls } from '../../../test-support/actions-fixtures.ts';
import { rowsOf } from '../../../test-support/fake-sql-session.ts';
import { surfaces } from '../../../test-support/http-connector.ts';
import {
  createSqlTarget,
  harnessOverSql,
  sqlInvocation,
  sqlWriteInvocation,
} from '../../../test-support/sql-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import { ActionError } from '../../errors.ts';
import { scrubVariants } from '../../scrub.ts';

const USERNAME = 'alice@example.com';

describe('the sql connector through the engine', () => {
  it('ACT-75 ACT-53 ACT-51 no variant of the credential reaches the result, the action_calls row, the audit trail or the log when the database echoes it back', async () => {
    const echoed = [
      CANARY.password,
      Buffer.from(CANARY.password, 'utf8').toString('base64'),
      encodeURIComponent(CANARY.password),
      JSON.stringify(CANARY.password),
      Buffer.from(`${USERNAME}:${CANARY.password}`, 'utf8').toString('base64'),
    ];
    const { harness } = harnessOverSql({
      answers: [
        rowsOf(
          ['leaked'],
          echoed.map((value) => [value]),
        ),
      ],
    });
    await createSqlTarget(harness);
    const result = resultOf(
      await harness.engine.call(caller({ scopes: ['actions:sql.read'] }), sqlInvocation()),
    );
    expect(result['rows']).toStrictEqual([
      ['[redacted:password]'],
      ['[redacted:password]'],
      ['[redacted:password]'],
      ['"[redacted:password]"'],
      ['[redacted:password]'],
    ]);
    const everything = surfaces(harness, [result]);
    const variants = scrubVariants(CANARY.password, USERNAME);
    expect(variants.filter((variant) => everything.includes(variant))).toStrictEqual([]);
  });

  it('ACT-53 ACT-51 ACT-24 a binary column carrying the credential comes back scrubbed, at any byte offset', async () => {
    const leaked: string[] = [];
    for (let offset = 0; offset < 6; offset += 1) {
      const raw = Buffer.concat([
        Buffer.alloc(offset, 0x41),
        Buffer.from(CANARY.password, 'utf8'),
        Buffer.from([0xff, 0xfe]),
      ]);
      const { harness } = harnessOverSql({ answers: [rowsOf(['blob'], [[raw]])] });
      await createSqlTarget(harness);
      const result = resultOf(
        await harness.engine.call(caller({ scopes: ['actions:sql.read'] }), sqlInvocation()),
      );
      const [[cell] = []] = result['rows'] as string[][];
      expect(Buffer.from(String(cell), 'base64').toString('latin1')).toBe(
        `${'A'.repeat(offset)}[redacted:password]\u{FF}\u{FE}`,
      );
      const everything = surfaces(harness, [result]);
      leaked.push(
        ...scrubVariants(CANARY.password, USERNAME).filter((variant) =>
          everything.includes(variant),
        ),
      );
    }
    expect(leaked).toStrictEqual([]);
  });

  it('ACT-53 ACT-74 a database error that quotes the credential is scrubbed before it leaves the engine', async () => {
    const { harness } = harnessOverSql({
      answers: [new ActionError('upstream_error', { message: `password "${CANARY.password}" ?` })],
    });
    await createSqlTarget(harness);
    const error = errorOf(
      await harness.engine.call(caller({ scopes: ['actions:sql.read'] }), sqlInvocation()),
    );
    expect(error.code).toBe('upstream_error');
    expect(error.detail).toStrictEqual({ message: 'password "[redacted:password]" ?' });
    expect(surfaces(harness, [])).not.toContain(CANARY.password);
  });

  it('ACT-60 ACT-26 records the statement class, the operation and the size of the rows returned', async () => {
    const { harness } = harnessOverSql({ answers: [rowsOf(['n'], [[1], [2]])] });
    await createSqlTarget(harness);
    const result = resultOf(
      await harness.engine.call(
        caller({ scopes: ['actions:sql.read'] }),
        sqlInvocation({ statement: 'SELECT n FROM t' }),
      ),
    );
    expect(result).toMatchObject({ row_count: 2, truncated: false });
    expect(storedCalls(harness.database)).toMatchObject([
      {
        outcome: 'ok',
        tool: 'sql_query',
        operation: 'read',
        classification: 'read',
        outputBytes: 8,
        outputTruncated: false,
      },
    ]);
  });

  it('ACT-26 ACT-39 a statement that is not a read is refused before any session is opened, with its reason', async () => {
    const { fake, harness } = harnessOverSql();
    await createSqlTarget(harness);
    const error = errorOf(
      await harness.engine.call(
        caller({ scopes: ['actions:sql.read'] }),
        sqlInvocation({ statement: 'DELETE FROM t' }),
      ),
    );
    expect(error.code).toBe('policy_denied');
    expect(error.detail).toStrictEqual({ reason: 'statement_class' });
    expect(fake.opened).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:policy_denied', classification: 'dml' },
    ]);
  });

  it('ACT-24 caps the rows at the target limit and says truncated', async () => {
    const { harness } = harnessOverSql({ answers: [rowsOf(['n'], [[1], [2], [3]])] });
    await createSqlTarget(harness, { policy: { max_rows: 2 } });
    const result = resultOf(
      await harness.engine.call(caller({ scopes: ['actions:sql.read'] }), sqlInvocation()),
    );
    expect(result).toMatchObject({ row_count: 2, truncated: true });
    expect(storedCalls(harness.database)).toMatchObject([{ outputTruncated: true }]);
  });

  it('ACT-59 the policy timeout aborts the statement and answers timeout', async () => {
    const { harness } = harnessOverSql({ answers: ['hang'] });
    await createSqlTarget(harness, { policy: { timeout_ms: 2000 } });
    const pending = harness.engine.call(caller({ scopes: ['actions:sql.read'] }), sqlInvocation());
    await harness.clock.advance(2000);
    expect(errorOf(await pending).code).toBe('timeout');
    expect(storedCalls(harness.database)).toMatchObject([{ outcome: 'error:timeout' }]);
  });

  it('ACT-53 a driver message quoting the credential is scrubbed on the one path that logs it, the failed session close', async () => {
    const { harness } = harnessOverSql({
      closeError: new Error(`FATAL: password authentication failed for "${CANARY.password}"`),
    });
    await createSqlTarget(harness);
    resultOf(await harness.engine.call(caller({ scopes: ['actions:sql.read'] }), sqlInvocation()));
    const logged = harness
      .logged()
      .filter((line) => line['msg'] === 'the sql session did not close cleanly');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.['reason']).toBe(
      'FATAL: password authentication failed for "[redacted:password]"',
    );
    expect(surfaces(harness, [])).not.toContain(CANARY.password);
  });

  it('ACT-60 ACT-63 a statement beyond the arguments cap is stored as an excerpt that says so and carries the digest of the whole', async () => {
    const statement = `DELETE FROM t WHERE note = '${'x'.repeat(5000)}' AND id = 1`;
    const { harness } = harnessOverSql();
    await createSqlTarget(harness, { policy: { operations: ['read', 'write'] } });
    resultOf(
      await harness.engine.call(
        caller({ scopes: ['actions:sql.write'] }),
        sqlWriteInvocation({ statement }),
      ),
    );
    const [stored] = storedCalls(harness.database);
    expect(stored?.argumentsTruncated).toBe(true);
    const whole = JSON.stringify({ target: 'warehouse', statement });
    expect(stored?.arguments).toContain(
      `[vaultgate: 4096 of ${String(Buffer.byteLength(whole))} bytes shown; sha256 of the whole is ` +
        `${createHash('sha256').update(whole, 'utf8').digest('hex')}]`,
    );
  });

  it('ACT-19 lists a sql target with its engine and the read operation only', async () => {
    const { harness } = harnessOverSql();
    await createSqlTarget(harness, { engine: 'mssql' });
    expect(harness.engine.listTargets(caller({ scopes: ['actions:sql.read'] }))).toStrictEqual([
      {
        name: 'warehouse',
        description: 'The reporting replica',
        connector: 'sql',
        operations: ['read'],
        confirm_writes: false,
        engine: 'mssql',
      },
    ]);
    expect(harness.engine.listTargets(caller({ scopes: ['actions:http'] }))).toStrictEqual([]);
  });
});
