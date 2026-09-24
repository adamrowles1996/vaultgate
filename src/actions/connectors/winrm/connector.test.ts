import { describe, expect, it } from 'vitest';

import { caller, errorOf, resultOf, storedCalls } from '../../../test-support/actions-fixtures.ts';
import { surfaces } from '../../../test-support/http-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import {
  createWinrmTarget,
  harnessOverWinrm,
  winrmInvocation,
} from '../../../test-support/winrm-connector.ts';
import { scrubVariants } from '../../scrub.ts';

const WINRM = { scopes: ['actions:winrm'] } as const;

const NUL_COMMAND = 'Get-\u{0}ComputerInfo';

describe('the winrm connector through the engine', () => {
  it('ACT-75 ACT-53 ACT-51 no variant of the password reaches the result, the action_calls row, the audit trail or the log when the host echoes it back', async () => {
    const echoed = [
      CANARY.password,
      Buffer.from(CANARY.password, 'utf8').toString('base64'),
      encodeURIComponent(CANARY.password),
    ].join('\n');
    const { harness } = harnessOverWinrm({
      receives: [
        { stdout: echoed, stderr: JSON.stringify(CANARY.password), done: true, exitCode: 0 },
      ],
    });
    await createWinrmTarget(harness);
    const result = resultOf(await harness.engine.call(caller(WINRM), winrmInvocation()));
    expect(result['stdout']).toBe('[redacted:password]\n[redacted:password]\n[redacted:password]');
    expect(result['stderr']).toBe('"[redacted:password]"');
    const everything = surfaces(harness, [result]);
    const variants = scrubVariants(CANARY.password, undefined);
    expect(variants.filter((variant) => everything.includes(variant))).toStrictEqual([]);
  });

  it('ACT-60 records the shell operation and the command classification with the output size', async () => {
    const { harness } = harnessOverWinrm({
      receives: [{ stdout: 'BUILD01', stderr: '!', done: true, exitCode: 0 }],
    });
    await createWinrmTarget(harness);
    const result = resultOf(await harness.engine.call(caller(WINRM), winrmInvocation()));
    expect(result).toMatchObject({
      exit_code: 0,
      stdout: 'BUILD01',
      stderr: '!',
      truncated: false,
    });
    expect(storedCalls(harness.database)).toMatchObject([
      {
        outcome: 'ok',
        tool: 'winrm_run',
        operation: 'shell',
        classification: 'command',
        connector: 'winrm',
        outputBytes: 8,
        outputTruncated: false,
      },
    ]);
  });

  it('ACT-39 refuses a command the allowlist does not match before anything connects, and audits it', async () => {
    const { fake, harness } = harnessOverWinrm();
    await createWinrmTarget(harness);
    const error = errorOf(
      await harness.engine.call(
        caller(WINRM),
        winrmInvocation({ command: String.raw`Remove-Item C:\ -Recurse` }),
      ),
    );
    expect(error.code).toBe('policy_denied');
    expect(error.detail).toStrictEqual({ reason: 'command' });
    expect(fake.requests).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:policy_denied', classification: 'command' },
    ]);
  });

  it('ACT-27 refuses a command with a NUL byte and one beyond 16 KiB as invalid arguments', async () => {
    const { fake, harness } = harnessOverWinrm();
    await createWinrmTarget(harness);
    const withNul = await harness.engine.call(
      caller(WINRM),
      winrmInvocation({ command: NUL_COMMAND }),
    );
    expect(errorOf(withNul).code).toBe('invalid_arguments');
    const tooLong = await harness.engine.call(
      caller(WINRM),
      winrmInvocation({ command: 'x'.repeat(16 * 1024 + 1) }),
    );
    expect(errorOf(tooLong).code).toBe('invalid_arguments');
    expect(fake.requests).toStrictEqual([]);
  });

  it('ACT-53 ACT-88 the full command of an any-command target is audited, scrubbed, even when it quotes the password', async () => {
    const command = `Write-Output ${CANARY.password}; ${'x'.repeat(5000)}`;
    const { harness } = harnessOverWinrm({}, { allowAnyCommand: true });
    await createWinrmTarget(harness, { policy: { allowed_commands: [], any_command: true } });
    resultOf(await harness.engine.call(caller(WINRM), winrmInvocation({ command })));
    const [stored] = storedCalls(harness.database);
    expect(stored?.classification).toBe(command.replace(CANARY.password, '[redacted:password]'));
    expect(stored?.argumentsTruncated).toBe(true);
    expect(surfaces(harness, [])).not.toContain(CANARY.password);
  });

  it('ACT-52 cuts each stream at the output limit, scrubbing across the cut, and says truncated', async () => {
    const straddling = `${'a'.repeat(30)}${CANARY.password}${'b'.repeat(4000)}`;
    const { harness } = harnessOverWinrm({
      receives: [{ stdout: straddling, stderr: 'c'.repeat(4000), done: true, exitCode: 0 }],
    });
    await createWinrmTarget(harness, { policy: { max_output_bytes: 1024 } });
    const result = resultOf(await harness.engine.call(caller(WINRM), winrmInvocation()));
    expect(result['stdout']).toContain('[redacted:password]');
    expect(String(result['stdout'])).not.toContain(CANARY.password);
    expect(String(result['stdout']).length).toBeLessThanOrEqual(1024);
    expect(String(result['stderr']).length).toBe(1024);
    expect(result['truncated']).toBe(true);
    expect(storedCalls(harness.database)).toMatchObject([{ outputTruncated: true }]);
  });

  it('ACT-59 ACT-90 the policy timeout terminates the command and deletes the shell, and answers timeout', async () => {
    const { fake, harness } = harnessOverWinrm({
      handler: (action) => (action === 'Receive' ? 'hang' : undefined),
    });
    await createWinrmTarget(harness, { policy: { timeout_ms: 2000 } });
    const pending = harness.engine.call(caller(WINRM), winrmInvocation());
    await harness.clock.advance(2000);
    expect(errorOf(await pending).code).toBe('timeout');
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Receive', 'Signal', 'Delete']);
    expect(storedCalls(harness.database)).toMatchObject([{ outcome: 'error:timeout' }]);
  });

  it('ACT-19 ACT-88 lists a winrm target with the shell operation, and marks an any-command one unrestricted', async () => {
    const { harness } = harnessOverWinrm({}, { allowAnyCommand: true });
    await createWinrmTarget(harness);
    await createWinrmTarget(harness, {
      name: 'jump-box',
      policy: { allowed_commands: [], any_command: true },
    });
    expect(harness.engine.listTargets(caller(WINRM))).toStrictEqual([
      {
        name: 'build-agent',
        description: 'The Windows build agent',
        connector: 'winrm',
        operations: ['shell'],
        confirm_writes: false,
      },
      {
        name: 'jump-box',
        description: 'The Windows build agent',
        connector: 'winrm',
        operations: ['shell'],
        confirm_writes: false,
        unrestricted: true,
      },
    ]);
    expect(harness.engine.listTargets(caller({ scopes: ['actions:ssh'] }))).toStrictEqual([]);
  });

  it('ACT-57 refuses a plain endpoint unless the operator marked the target internal', async () => {
    const { harness } = harnessOverWinrm();
    const refused = await harness.engine.targets.create(
      {
        name: 'plain-host',
        description: 'A host on the internal network',
        connector: 'winrm',
        destination: { url: 'http://win.example.com:5985/wsman', username: 'vaultgate' },
        internal: false,
        credential: { item_id: 'item-login', mapping: {} },
        policy: { allowed_commands: ['Get-ComputerInfo'] },
        enabled: true,
      },
      'operator-1',
    );
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? [] : refused.error.problems).toContain(
      'destination: plain transport to "win.example.com" needs internal: true',
    );
  });
});
