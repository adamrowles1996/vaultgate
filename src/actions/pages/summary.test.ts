import { describe, expect, it } from 'vitest';

import { caller, createHttpTarget, httpInvocation } from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { fixtureTargetRow } from '../../test-support/actions-store-fixtures.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';
import { createSqlTarget } from '../../test-support/sql-connector.ts';
import { createSshTarget } from '../../test-support/ssh-connector.ts';

import { allowsOf, summarise } from './summary.ts';

describe('what a computer allows, in a few words', () => {
  it('ACT-5 reads the policy in force of each connector', () => {
    expect(allowsOf('sql', { operations: ['read'] })).toBe('Read only');
    expect(allowsOf('sql', { operations: ['read', 'write'] })).toBe('Read and write');
    expect(allowsOf('ssh', { allowed_commands: ['uptime'] })).toBe('1 command');
    expect(allowsOf('winrm', { allowed_commands: ['a', 'b'] })).toBe('2 commands');
    expect(allowsOf('winrm', { any_command: true })).toBe('Any command');
    expect(allowsOf('http', { allowed_methods: ['GET', 'POST'] })).toBe('GET, POST');
    expect(allowsOf('http', {})).toBe('');
    expect(allowsOf('browser', { operations: ['read'] })).toBe('');
  });

  it('ACT-5 ACT-57 summarises the address, the transport and the fields, and says little of an invalid row', async () => {
    const harness = createPagesHarness({ addresses: { 'intranet.example': ['10.0.0.8'] } });
    const plain = await createHttpTarget(harness.actions, {
      name: 'intranet',
      base_url: 'http://intranet.example/api',
      internal: true,
    });
    expect(summarise(plain)).toMatchObject({
      kind: 'http',
      address: 'intranet.example/api',
      addressDetail: 'internal · plain transport',
      fields: [{ selector: 'password', isSecret: true }],
      confirmation: 'reads',
      state: 'enabled',
    });
    const sql = await createSqlTarget(harness.actions, { engine: 'mssql' });
    expect(summarise(sql)).toMatchObject({
      kind: 'mssql',
      allows: 'Read only',
      fields: [
        { selector: 'login.username', isSecret: false },
        { selector: 'password', isSecret: true },
      ],
    });
    const invalid = fixtureTargetRow({ id: 'row-1', name: 'broken', policy: 'nope' });
    harness.actions.engine.targets.repo.insert(invalid);
    const stored = harness.actions.engine.targets.get('row-1');
    expect(stored === undefined ? undefined : summarise(stored)).toMatchObject({
      address: 'not readable',
      addressDetail: 'not readable',
      allows: '',
      fields: [],
      state: 'invalid',
    });
  });
});

describe('the Computers page, for every kind of computer', () => {
  it('ACT-4 ACT-5 ACT-63 files SQL Server, PostgreSQL and SSH apart, shows a missing item and counts the unexpected writes', async () => {
    const harness = createPagesHarness();
    await createSqlTarget(harness.actions, { name: 'erp', engine: 'mssql' });
    await createSqlTarget(harness.actions, { name: 'warehouse' });
    await createSshTarget(harness.actions, {
      name: 'web',
      policy: { allowed_commands: ['uptime', 'w'], confirm_writes: true },
    });
    await createHttpTarget(harness.actions, {
      name: 'writer',
      policy: { allowed_methods: ['GET', 'POST'], confirm_writes: false },
    });
    harness.actions.engine.targets.repo.insert(
      fixtureTargetRow({
        id: 'row-1',
        name: 'gone',
        credential: { item_id: 'item-nope', mapping: {} },
      }),
    );
    await harness.actions.engine.call(
      caller(),
      httpInvocation({ target: 'writer', method: 'POST', body: 'x' }),
    );
    const { browser } = await signedInOperator(harness, false);
    const markup = compact(await pageText(browser, '/account/actions'));
    expect(markup).toContain('>SQL Server <span class="count">1</span>');
    expect(markup).toContain('>PostgreSQL <span class="count">1</span>');
    expect(markup).toContain('>Linux · SSH <span class="count">1</span>');
    expect(markup).toContain('<span class="field-chip">login.username</span>');
    expect(markup).toContain('<span>2 commands</span>');
    expect(markup).toContain('A person confirms writes');
    expect(markup).toContain('no such item in the vault');
    expect(markup).toContain('<span class="bad">');
    expect(markup).toContain(
      '<a href="/account/actions/unexpected">1 unexpected writes this week</a>',
    );
    const sidebar = markup.slice(markup.indexOf('<aside'), markup.indexOf('</aside>'));
    expect(sidebar).toContain('<span class="nav-badge" title="1 unexpected writes this week">');
  });
});
