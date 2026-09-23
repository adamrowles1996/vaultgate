import { describe, expect, it } from 'vitest';

import {
  fakeSshClient,
  HOST_KEYS,
  type FakeSshOptions,
} from '../../../test-support/fake-ssh-client.ts';
import {
  sshRunContext,
  SSH_HOST,
  SSH_USERNAME,
  type SshContextOptions,
} from '../../../test-support/ssh-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import { ActionError } from '../../errors.ts';

import { createRun } from './run.ts';

import type { SshOperation } from './operation.ts';

const UPTIME: SshOperation = { command: 'uptime', stdin: undefined };

async function run(
  fakeOptions: FakeSshOptions = {},
  contextOptions: SshContextOptions = {},
  operation: SshOperation = UPTIME,
) {
  const fake = fakeSshClient(fakeOptions);
  const built = sshRunContext(contextOptions);
  const outcome = await createRun(fake.open)(built.context, operation);
  return { fake, built, outcome };
}

describe('running one ssh command', () => {
  it('ACT-55 ACT-87 connects to the pinned address with the host name and the pinned key, as the target login', async () => {
    const { fake, outcome } = await run();
    expect(outcome.ok).toBe(true);
    expect(fake.opened[0]).toMatchObject({
      host: SSH_HOST,
      address: '93.184.216.34',
      port: 22,
      username: SSH_USERNAME,
      hostKey: HOST_KEYS.pinned,
    });
  });

  it('ACT-50 offers the private key the mapping names, read out of the injected values', async () => {
    const { fake } = await run();
    expect(fake.opened[0]?.auth).toStrictEqual({
      kind: 'key',
      privateKey: CANARY.sshPrivateKey,
      passphrase: undefined,
    });
  });

  it('ACT-50 offers the key passphrase when the mapping names one', async () => {
    const { fake } = await run(
      {},
      {
        credential: {
          auth: 'key',
          key_field: 'sshKey.privateKey',
          passphrase_field: 'custom.key-passphrase',
        },
        secrets: {
          'sshKey.privateKey': CANARY.sshPrivateKey,
          'custom.key-passphrase': CANARY.hiddenField,
        },
      },
    );
    expect(fake.opened[0]?.auth).toStrictEqual({
      kind: 'key',
      privateKey: CANARY.sshPrivateKey,
      passphrase: CANARY.hiddenField,
    });
  });

  it('ACT-50 offers the password when the mapping is a password one', async () => {
    const { fake } = await run(
      {},
      {
        credential: { auth: 'password', password_field: 'password' },
        secrets: { password: CANARY.password },
      },
    );
    expect(fake.opened[0]?.auth).toStrictEqual({ kind: 'password', password: CANARY.password });
  });

  it('ACT-54 answers credential_unavailable without connecting when a mapped field is missing', async () => {
    const missingKey = await run({}, { secrets: {} });
    expect(missingKey.outcome).toMatchObject({ ok: false });
    expect(missingKey.fake.opened).toStrictEqual([]);
    const missingPassphrase = await run(
      {},
      {
        credential: {
          auth: 'key',
          key_field: 'sshKey.privateKey',
          passphrase_field: 'custom.key-passphrase',
        },
        secrets: { 'sshKey.privateKey': CANARY.sshPrivateKey },
      },
    );
    expect(missingPassphrase.outcome).toStrictEqual({
      ok: false,
      error: new ActionError('credential_unavailable'),
    });
    const missingPassword = await run(
      {},
      { credential: { auth: 'password', password_field: 'password' }, secrets: {} },
    );
    expect(missingPassword.outcome).toMatchObject({ ok: false });
    expect(missingPassword.fake.opened).toStrictEqual([]);
  });

  it('ACT-55 refuses to run when the engine pinned no address at all', async () => {
    const { fake, outcome } = await run({}, { pinned: [] });
    expect(outcome).toStrictEqual({
      ok: false,
      error: new ActionError('destination_refused', { reason: 'unpinned' }),
    });
    expect(fake.opened).toStrictEqual([]);
  });

  it('ACT-27 ACT-52 captures the two streams to the limit plus the guard band and reports the exit code', async () => {
    const { fake, outcome } = await run(
      { answers: [{ exitCode: 7, stdout: Buffer.from('out'), stderr: Buffer.from('err') }] },
      { maxOutputBytes: 1024 },
      { command: 'uptime', stdin: 'payload' },
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        result: { exit_code: 7, truncated: false },
        captured: { stdout: Buffer.from('out'), stderr: Buffer.from('err') },
      },
    });
    const [request] = fake.commands;
    expect(request?.command).toBe('uptime');
    expect(request?.stdin).toBe('payload');
    expect(request?.captureBytes).toBeGreaterThan(1024);
  });

  it('ACT-27 passes a null exit code through untouched', async () => {
    const { outcome } = await run({ answers: [{ exitCode: null, truncated: true }] });
    expect(outcome).toMatchObject({
      ok: true,
      value: { result: { exit_code: null, truncated: true } },
    });
  });

  it('ACT-58 ends the connection when the call ends, whatever the outcome', async () => {
    const good = await run();
    expect(good.fake.closed).toStrictEqual([1]);
    const bad = await run({ answers: [new Error('broken pipe')] });
    expect(bad.outcome).toMatchObject({ ok: false, error: { code: 'upstream_error' } });
    expect(bad.fake.closed).toStrictEqual([1]);
  });

  it('ACT-58 logs a connection that will not close and keeps the call outcome', async () => {
    const { built, outcome } = await run({ closeError: new Error('already gone') });
    expect(outcome.ok).toBe(true);
    expect(built.logged()).toMatchObject([{ reason: 'already gone' }]);
  });

  it('ACT-87 answers host_key_mismatch when the server presents another key', async () => {
    const { fake, outcome } = await run({ presents: HOST_KEYS.other });
    expect(outcome).toStrictEqual({ ok: false, error: new ActionError('host_key_mismatch') });
    expect(fake.offered).toStrictEqual([]);
    expect(fake.closed).toStrictEqual([]);
  });

  it('ACT-74 answers authentication_failed when the server rejects the credential', async () => {
    const { fake, outcome } = await run({ authFails: true });
    expect(outcome).toStrictEqual({ ok: false, error: new ActionError('authentication_failed') });
    expect(fake.offered).toStrictEqual([CANARY.sshPrivateKey]);
  });

  it('ACT-74 turns a connection failure that is not an action error into upstream_error', async () => {
    const { outcome } = await run({ openError: new Error('something odd') });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'upstream_error', detail: { message: 'something odd' } },
    });
  });

  it('ACT-59 lets the engine timeout through and closes the connection behind it', async () => {
    const fake = fakeSshClient({ answers: ['hang'] });
    const built = sshRunContext();
    const pending = createRun(fake.open)(built.context, UPTIME);
    built.controller.abort();
    expect(await pending).toStrictEqual({ ok: false, error: new ActionError('timeout') });
    expect(fake.closed).toStrictEqual([1]);
  });
});
