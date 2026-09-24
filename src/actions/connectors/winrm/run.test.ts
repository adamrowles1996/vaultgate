import { describe, expect, it } from 'vitest';

import { fakeWsman, type FakeWsmanOptions } from '../../../test-support/fake-wsman.ts';
import { unwrapOk } from '../../../test-support/result.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import {
  winrmRunContext,
  winrmSessionOverFake,
  type WinrmContextOptions,
} from '../../../test-support/winrm-connector.ts';

import { createRun } from './run.ts';

import type { WinrmOperation } from './operation.ts';
import type { WinrmSession, WinrmSessionFactory } from './session.ts';
import type { Result } from '../../../result.ts';
import type { ActionError } from '../../errors.ts';
import type { ConnectorOutput } from '../connector.ts';

const GET_INFO: WinrmOperation = { command: 'Get-ComputerInfo' };

interface Ran {
  readonly outcome: Result<ConnectorOutput, ActionError>;
  readonly built: ReturnType<typeof winrmRunContext>;
}

async function run(
  options: FakeWsmanOptions = {},
  context: WinrmContextOptions = {},
  operation: WinrmOperation = GET_INFO,
): Promise<Ran> {
  const built = winrmRunContext(context);
  const fake = fakeWsman(options);
  const outcome = await createRun(winrmSessionOverFake(fake))(built.context, operation);
  return { outcome, built };
}

function errorOf(outcome: Result<ConnectorOutput, ActionError>): ActionError {
  if (outcome.ok) {
    throw new Error('expected the run to fail');
  }
  return outcome.error;
}

describe('the winrm run', () => {
  it('ACT-27 ACT-52 returns the exit code and both captured streams', async () => {
    const { outcome } = await run({
      receives: [{ stdout: 'name: BUILD01', stderr: 'note', done: true, exitCode: 0 }],
    });
    const output = unwrapOk(outcome);
    expect(output.result).toStrictEqual({ exit_code: 0, truncated: false });
    expect(output.captured['stdout']?.toString('utf8')).toBe('name: BUILD01');
    expect(output.captured['stderr']?.toString('utf8')).toBe('note');
  });

  it('ACT-55 refuses a call whose destination was never pinned, with nothing opened', async () => {
    const { outcome } = await run({}, { pinned: [] });
    expect(errorOf(outcome).code).toBe('destination_refused');
    expect(errorOf(outcome).detail).toStrictEqual({ reason: 'unpinned' });
  });

  it('ACT-50 ACT-54 refuses a call whose password field holds nothing', async () => {
    const { outcome } = await run({}, { secrets: {} });
    expect(errorOf(outcome).code).toBe('credential_unavailable');
  });

  it('ACT-50 signs in with the vault password the mapping names', async () => {
    const fake = fakeWsman();
    const built = winrmRunContext({
      credential: { password_field: 'custom.host-password' },
      secrets: { 'custom.host-password': CANARY.hiddenField },
    });
    await createRun(winrmSessionOverFake(fake))(built.context, GET_INFO);
    expect(fake.requests[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from(`vaultgate:${CANARY.hiddenField}`, 'utf8').toString('base64')}`,
    );
  });

  it('ACT-58 deletes the shell when the call ends, and when it fails', async () => {
    const fake = fakeWsman();
    const built = winrmRunContext();
    await createRun(winrmSessionOverFake(fake))(built.context, GET_INFO);
    expect(fake.actions.at(-1)).toBe('Delete');
    const failing = fakeWsman({
      handler: (action) => (action === 'Command' ? new Error('gone') : undefined),
    });
    const outcome = await createRun(winrmSessionOverFake(failing))(
      winrmRunContext().context,
      GET_INFO,
    );
    expect(errorOf(outcome).code).toBe('connection_failed');
    expect(failing.actions.at(-1)).toBe('Delete');
  });

  it('ACT-58 logs a shell that will not delete and keeps the call result', async () => {
    const fake = fakeWsman({
      handler: (action) => (action === 'Delete' ? new Error('shell already gone') : undefined),
    });
    const built = winrmRunContext();
    const outcome = await createRun(winrmSessionOverFake(fake))(built.context, GET_INFO);
    expect(outcome.ok).toBe(true);
    expect(built.logged()).toMatchObject([
      {
        msg: 'the winrm shell did not delete cleanly',
        reason: 'the destination could not be reached',
      },
    ]);
  });

  it('§13.16 reports an unclassified failure as upstream_error and a JavaScript fault as its own', async () => {
    const failing = (error: Error): WinrmSessionFactory => {
      const session: WinrmSession = {
        run: () => Promise.reject(error),
        close: () => Promise.resolve(),
      };
      return () => Promise.resolve(session);
    };
    const odd = await createRun(failing(new Error('something odd')))(
      winrmRunContext().context,
      GET_INFO,
    );
    expect(errorOf(odd).code).toBe('upstream_error');
    expect(errorOf(odd).detail).toStrictEqual({ message: 'something odd' });
    const bug = await createRun(failing(new TypeError('a fault of our own')))(
      winrmRunContext().context,
      GET_INFO,
    );
    expect(errorOf(bug).code).toBe('connector_fault');
  });

  it('ACT-57 fails a certificate the target did not pin as tls_error, with no shell opened', async () => {
    const fake = fakeWsman({
      handler: () => Object.assign(new Error('pin'), { code: 'ERR_TLS_CERT_PIN_MISMATCH' }),
    });
    const built = winrmRunContext({
      destination: {
        certificate_sha256: 'bb'.repeat(32),
      },
    });
    const outcome = await createRun(winrmSessionOverFake(fake))(built.context, GET_INFO);
    expect(errorOf(outcome).code).toBe('tls_error');
    expect(fake.actions).toStrictEqual(['Create']);
  });
});
