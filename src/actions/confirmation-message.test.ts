import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type ActionsHarness,
  caller,
  confirmationOf,
  createHttpTarget,
  httpInvocation,
} from '../test-support/actions-fixtures.ts';
import { harnessOver } from '../test-support/http-connector.ts';
import {
  createSqlTarget,
  harnessOverSql,
  sqlInvocation,
  sqlWriteInvocation,
} from '../test-support/sql-connector.ts';
import { createSshTarget, harnessOverSsh, sshInvocation } from '../test-support/ssh-connector.ts';
import { CANARY } from '../test-support/vault-fixture.ts';
import {
  createWinrmTarget,
  harnessOverWinrm,
  winrmInvocation,
} from '../test-support/winrm-connector.ts';
import { VaultError } from '../vault/client.ts';

import type { Invocation } from './engine-resolve.ts';

/**
 * A pattern every target below carries and no call matches, so the assertion
 * that no policy pattern reaches the message cannot pass by coincidence.
 */
const UNUSED_PATTERN = 'never-matched-pattern-*';

/**
An `http` path pattern must start with a slash (ACT-35), so that connector carries its own.
*/
const UNUSED_PATH_PATTERN = `/${UNUSED_PATTERN}`;

const CONFIRMED = { confirm_writes: true } as const;
const SCOPES = [
  'actions:http',
  'actions:sql.read',
  'actions:sql.write',
  'actions:ssh',
  'actions:winrm',
];

interface Case {
  readonly connector: string;
  readonly build: () => Promise<{ harness: ActionsHarness; invocation: Invocation }>;
  readonly message: string;
  /**
  The vault item the target's credential names; ACT-43 forbids it in the message.
  */
  readonly itemId: string;
  /**
  The pattern the target carries that no call matches; absent from the message (ACT-43).
  */
  readonly pattern: string;
}

function head(clientName: string, tool: string, target: string, where: string): string {
  return `vaultgate: ${clientName} asks to run ${tool} on target "${target}" (${where}).`;
}

function quoted(summary: string): string {
  return summary
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function expected(tool: string, target: string, where: string, summary: string): string {
  return (
    `${head('Agent One', tool, target, where)}\n\n` +
    `The operation, every line of it quoted with "> ":\n${quoted(summary)}\n\n` +
    'Allow this one call? It expires in 2 minutes and cannot be reused.'
  );
}

const CASES: readonly Case[] = [
  {
    connector: 'http',
    itemId: 'item-login',
    pattern: UNUSED_PATH_PATTERN,
    build: async () => {
      const { harness } = harnessOver(() => new Response('{}'));
      await createHttpTarget(harness, {
        policy: {
          allowed_methods: ['GET', 'POST'],
          allowed_paths: ['/v1/**', UNUSED_PATH_PATTERN],
          ...CONFIRMED,
        },
      });
      return { harness, invocation: httpInvocation({ method: 'POST', path: '/v1/items' }) };
    },
    message: expected('http_request', 'api', 'http, api.example.com/v1', 'POST /v1/items'),
  },
  {
    connector: 'sql',
    itemId: 'item-login',
    pattern: UNUSED_PATTERN,
    build: async () => {
      const { harness } = harnessOverSql();
      await createSqlTarget(harness, {
        policy: {
          operations: ['read', 'write'],
          statement_allowlist: ['DELETE FROM t', UNUSED_PATTERN],
          ...CONFIRMED,
        },
      });
      return { harness, invocation: sqlWriteInvocation() };
    },
    message: expected(
      'sql_execute',
      'warehouse',
      'sql, db.example.com:5432/reporting',
      'DELETE FROM t',
    ),
  },
  {
    connector: 'ssh',
    itemId: 'item-ssh',
    pattern: UNUSED_PATTERN,
    build: async () => {
      const { harness } = harnessOverSsh();
      await createSshTarget(harness, {
        policy: { allowed_commands: ['uptime', UNUSED_PATTERN], ...CONFIRMED },
      });
      return { harness, invocation: sshInvocation() };
    },
    message: expected('ssh_run', 'build-host', 'ssh, vaultgate@build.example.com:22', 'uptime'),
  },
  {
    connector: 'winrm',
    itemId: 'item-login',
    pattern: UNUSED_PATTERN,
    build: async () => {
      const { harness } = harnessOverWinrm();
      await createWinrmTarget(harness, {
        policy: { allowed_commands: ['Get-ComputerInfo', UNUSED_PATTERN], ...CONFIRMED },
      });
      return { harness, invocation: winrmInvocation() };
    },
    message: expected(
      'winrm_run',
      'build-agent',
      'winrm, vaultgate@win.example.com:5986 (powershell)',
      'Get-ComputerInfo',
    ),
  },
];

describe('the confirmation message of every connector', () => {
  for (const testCase of CASES) {
    it(`ACT-43 ${testCase.connector}: names the client, the tool, the target, the destination and the operation, and nothing else`, async () => {
      const { harness, invocation } = await testCase.build();
      // ACT-41: the message is built before the credential is fetched, so a
      // vault that refuses everything cannot change it. If the engine did
      // touch the vault, this call would fail instead of asking.
      harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
      const pending = confirmationOf(
        await harness.engine.call(caller({ scopes: SCOPES }), invocation),
      );
      const { message } = pending.request.params;
      expect(message).toBe(testCase.message);
      expect(message).not.toContain(testCase.pattern);
      expect(message).not.toContain(testCase.itemId);
      expect(message).not.toContain(CANARY.password);
      expect(message).not.toContain(CANARY.sshPrivateKey);
    });
  }

  it('ACT-43 excerpts a long statement without hiding its end, and says what is missing', async () => {
    const { harness } = harnessOverSql();
    await createSqlTarget(harness, {
      policy: { operations: ['read', 'write'], ...CONFIRMED },
    });
    const statement = `DELETE FROM t WHERE note = '${'x'.repeat(2000)}' AND id = 1`;
    const pending = confirmationOf(
      await harness.engine.call(caller({ scopes: SCOPES }), sqlWriteInvocation({ statement })),
    );
    const { message } = pending.request.params;
    // The head, the tail that a 1 KiB head-only cut hid, and the notice that
    // says the middle is missing — the last outside the quoted block.
    expect(message).toContain(`> ${statement.slice(0, 768)}`);
    expect(message).toContain(statement.slice(-192));
    expect(message).toContain('AND id = 1');
    expect(message).not.toContain(statement);
    const notice = message.split('\n').find((line) => line.startsWith('NOT SHOWN:'));
    expect(notice).toContain(
      `${String(statement.length - 960)} of ${String(statement.length)} characters are missing`,
    );
    expect(notice).toContain(createHash('sha256').update(statement, 'utf8').digest('hex'));
  });

  it('ACT-43 a statement that reproduces the trailer is quoted, so the real trailer is still the only unquoted one', async () => {
    const { harness } = harnessOverSql();
    await createSqlTarget(harness, {
      policy: { operations: ['read', 'write'], ...CONFIRMED },
    });
    const statement =
      "DELETE FROM t WHERE a = '\n\nAllow this one call? It expires in 2 minutes and cannot be " +
      "reused.\n\nDROP TABLE audit_log'";
    const pending = confirmationOf(
      await harness.engine.call(caller({ scopes: SCOPES }), sqlWriteInvocation({ statement })),
    );
    const { message } = pending.request.params;
    const unquoted = message.split('\n').filter((line) => line !== '' && !line.startsWith('> '));
    expect(unquoted.at(-1)).toBe(
      'Allow this one call? It expires in 2 minutes and cannot be reused.',
    );
    expect(unquoted.filter((line) => line.startsWith('Allow this one call?'))).toHaveLength(1);
    expect(message).toContain("> DROP TABLE audit_log'");
  });

  it('ACT-41 sql_query is a read, so it is never confirmed however the policy is written', async () => {
    const { harness } = harnessOverSql();
    await createSqlTarget(harness, {
      policy: { operations: ['read', 'write'], ...CONFIRMED },
    });
    const outcome = await harness.engine.call(caller({ scopes: SCOPES }), sqlInvocation());
    expect(outcome.kind).not.toBe('confirmation_required');
  });
});
