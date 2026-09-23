import { describe, expect, it } from 'vitest';

import { caller, errorOf, resultOf, storedCalls } from '../../../test-support/actions-fixtures.ts';
import { HOST_KEYS } from '../../../test-support/fake-ssh-client.ts';
import { surfaces } from '../../../test-support/http-connector.ts';
import {
  createSshTarget,
  harnessOverSsh,
  sshInvocation,
} from '../../../test-support/ssh-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import { scrubVariants } from '../../scrub.ts';

const SSH = { scopes: ['actions:ssh'] } as const;

const NUL_COMMAND = 'up\u{0}time';

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

describe('the ssh connector through the engine', () => {
  it('ACT-75 ACT-53 ACT-51 no variant of the private key reaches the result, the action_calls row, the audit trail or the log when the server echoes it back', async () => {
    const echoed = [
      CANARY.sshPrivateKey,
      bytes(CANARY.sshPrivateKey).toString('base64'),
      encodeURIComponent(CANARY.sshPrivateKey),
    ].join('\n');
    const { harness } = harnessOverSsh({
      answers: [{ stdout: bytes(echoed), stderr: bytes(JSON.stringify(CANARY.sshPrivateKey)) }],
    });
    await createSshTarget(harness);
    const result = resultOf(await harness.engine.call(caller(SSH), sshInvocation()));
    expect(result['stdout']).toBe(
      '[redacted:sshKey.privateKey]\n[redacted:sshKey.privateKey]\n[redacted:sshKey.privateKey]',
    );
    expect(result['stderr']).toBe('"[redacted:sshKey.privateKey]"');
    const everything = surfaces(harness, [result]);
    const variants = scrubVariants(CANARY.sshPrivateKey, undefined);
    expect(variants.filter((variant) => everything.includes(variant))).toStrictEqual([]);
  });

  it('ACT-53 ACT-88 the full command of an any-command target is audited, scrubbed, even when it quotes the key', async () => {
    const command = `echo ${CANARY.sshPrivateKey} && ${'x'.repeat(5000)}`;
    const { harness } = harnessOverSsh({}, { allowAnyCommand: true });
    await createSshTarget(harness, { policy: { allowed_commands: [], any_command: true } });
    resultOf(await harness.engine.call(caller(SSH), sshInvocation({ command })));
    const [stored] = storedCalls(harness.database);
    const redacted = command.replace(CANARY.sshPrivateKey, '[redacted:sshKey.privateKey]');
    expect(stored?.classification).toBe(redacted);
    expect(stored?.argumentsTruncated).toBe(true);
    expect(surfaces(harness, [])).not.toContain(CANARY.sshPrivateKey);
  });

  it('ACT-60 records the shell operation and the command classification with the output size', async () => {
    const { harness } = harnessOverSsh({
      answers: [{ exitCode: 0, stdout: bytes('up 3 days'), stderr: bytes('!') }],
    });
    await createSshTarget(harness);
    const result = resultOf(await harness.engine.call(caller(SSH), sshInvocation()));
    expect(result).toMatchObject({
      exit_code: 0,
      stdout: 'up 3 days',
      stderr: '!',
      truncated: false,
    });
    expect(storedCalls(harness.database)).toMatchObject([
      {
        outcome: 'ok',
        tool: 'ssh_run',
        operation: 'shell',
        classification: 'command',
        outputBytes: 10,
        outputTruncated: false,
      },
    ]);
  });

  it('ACT-39 refuses a command the allowlist does not match before anything connects, and audits it', async () => {
    const { fake, harness } = harnessOverSsh();
    await createSshTarget(harness);
    const error = errorOf(
      await harness.engine.call(caller(SSH), sshInvocation({ command: 'rm -rf /' })),
    );
    expect(error.code).toBe('policy_denied');
    expect(error.detail).toStrictEqual({ reason: 'command' });
    expect(fake.opened).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:policy_denied', classification: 'command' },
    ]);
  });

  it('ACT-27 refuses a command with a NUL byte and one beyond 16 KiB as invalid arguments', async () => {
    const { fake, harness } = harnessOverSsh();
    await createSshTarget(harness);
    const withNul = await harness.engine.call(caller(SSH), sshInvocation({ command: NUL_COMMAND }));
    expect(errorOf(withNul).code).toBe('invalid_arguments');
    const tooLong = sshInvocation({ command: 'x'.repeat(16 * 1024 + 1) });
    const refused = await harness.engine.call(caller(SSH), tooLong);
    expect(errorOf(refused).code).toBe('invalid_arguments');
    expect(fake.opened).toStrictEqual([]);
  });

  it('ACT-87 fails a host-key mismatch before any credential is offered', async () => {
    const { fake, harness } = harnessOverSsh({ presents: HOST_KEYS.other });
    await createSshTarget(harness);
    const error = errorOf(await harness.engine.call(caller(SSH), sshInvocation()));
    expect(error.code).toBe('host_key_mismatch');
    expect(fake.offered).toStrictEqual([]);
    expect(fake.commands).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([{ outcome: 'error:host_key_mismatch' }]);
  });

  it('ACT-87 accepts the same key pinned as a SHA256 fingerprint', async () => {
    const { fake, harness } = harnessOverSsh();
    await createSshTarget(harness, { destination: { host_key: HOST_KEYS.fingerprint } });
    const outcome = await harness.engine.call(caller(SSH), sshInvocation());
    expect(resultOf(outcome)).toMatchObject({ exit_code: 0 });
    expect(fake.offered).toStrictEqual([CANARY.sshPrivateKey]);
  });

  it('ACT-52 cuts each stream at the output limit, scrubbing across the cut, and says truncated', async () => {
    const straddling = `${'a'.repeat(30)}${CANARY.sshPrivateKey}${'b'.repeat(4000)}`;
    const { harness } = harnessOverSsh({
      answers: [{ stdout: bytes(straddling), stderr: bytes('c'.repeat(4000)) }],
    });
    await createSshTarget(harness, { policy: { max_output_bytes: 1024 } });
    const result = resultOf(await harness.engine.call(caller(SSH), sshInvocation()));
    expect(result['stdout']).toContain('[redacted:sshKey.privateKey]');
    expect(String(result['stdout'])).not.toContain(CANARY.sshPrivateKey);
    expect(String(result['stdout']).length).toBeLessThanOrEqual(1024);
    expect(String(result['stderr']).length).toBe(1024);
    expect(result['truncated']).toBe(true);
    expect(storedCalls(harness.database)).toMatchObject([{ outputTruncated: true }]);
  });

  it('ACT-59 the policy timeout kills the command and answers timeout', async () => {
    const { fake, harness } = harnessOverSsh({ answers: ['hang'] });
    await createSshTarget(harness, { policy: { timeout_ms: 2000 } });
    const pending = harness.engine.call(caller(SSH), sshInvocation());
    await harness.clock.advance(2000);
    expect(errorOf(await pending).code).toBe('timeout');
    expect(fake.killed).toStrictEqual([1]);
    expect(storedCalls(harness.database)).toMatchObject([{ outcome: 'error:timeout' }]);
  });

  it('ACT-19 ACT-88 lists an ssh target with the shell operation, and marks an any-command one unrestricted', async () => {
    const { harness } = harnessOverSsh({}, { allowAnyCommand: true });
    await createSshTarget(harness);
    await createSshTarget(harness, {
      name: 'jump-host',
      policy: { allowed_commands: [], any_command: true },
    });
    expect(harness.engine.listTargets(caller(SSH))).toStrictEqual([
      {
        name: 'build-host',
        description: 'The build server',
        connector: 'ssh',
        operations: ['shell'],
        confirm_writes: false,
      },
      {
        name: 'jump-host',
        description: 'The build server',
        connector: 'ssh',
        operations: ['shell'],
        confirm_writes: false,
        unrestricted: true,
      },
    ]);
    expect(harness.engine.listTargets(caller({ scopes: ['actions:http'] }))).toStrictEqual([]);
  });
});
