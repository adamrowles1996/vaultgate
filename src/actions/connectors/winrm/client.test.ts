import { describe, expect, it } from 'vitest';

import {
  COMMAND_ID,
  fakeWsman,
  SHELL_ID,
  soapFault,
  soapResponse,
  type FakeWsman,
  type FakeWsmanOptions,
} from '../../../test-support/fake-wsman.ts';
import {
  CERTIFICATE_SHA256,
  winrmSessionOverFake,
  WINRM_URL,
  WINRM_USERNAME,
} from '../../../test-support/winrm-connector.ts';
import { ActionError } from '../../errors.ts';

import { TERMINATE } from './envelopes.ts';

import type { WinrmCommand, WinrmConnection, WinrmSession } from './session.ts';

const ADDRESS = '93.184.216.34';
const PASSWORD = 'canary-winrm-password';
const COMMAND: WinrmCommand = {
  command: 'Get-ComputerInfo',
  stdin: undefined,
  captureBytes: 1024,
};

interface Opened {
  readonly fake: FakeWsman;
  readonly session: WinrmSession;
  readonly controller: AbortController;
}

async function open(
  options: FakeWsmanOptions = {},
  overrides: Partial<WinrmConnection> = {},
): Promise<Opened> {
  const fake = fakeWsman(options);
  const controller = new AbortController();
  const connection: WinrmConnection = {
    url: WINRM_URL,
    address: ADDRESS,
    username: WINRM_USERNAME,
    password: PASSWORD,
    auth: 'basic',
    shell: 'powershell',
    certificateSha256: undefined,
    signal: controller.signal,
    ...overrides,
  };
  return { fake, controller, session: await winrmSessionOverFake(fake)(connection) };
}

/**
Drains microtasks until the fake destination has seen that operation, so the abort lands mid-poll.
*/
async function untilAction(fake: FakeWsman, action: string): Promise<void> {
  for (let turn = 0; turn < 100 && !fake.actions.includes(action); turn += 1) {
    await Promise.resolve();
  }
}

async function errorOf(run: Promise<unknown>): Promise<ActionError> {
  try {
    await run;
  } catch (error: unknown) {
    if (error instanceof ActionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('the WS-Management client', () => {
  it('ACT-89 ACT-90 drives Create, Command, Receive and Delete in that order and returns both streams', async () => {
    const { fake, session } = await open({
      receives: [
        { stdout: 'info' },
        { stdout: ' more', stderr: 'warning', done: true, exitCode: 0 },
      ],
    });
    const result = await session.run(COMMAND);
    await session.close();
    expect(result).toStrictEqual({
      exitCode: 0,
      stdout: Buffer.from('info more', 'utf8'),
      stderr: Buffer.from('warning', 'utf8'),
      truncated: false,
    });
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Receive', 'Receive', 'Delete']);
  });

  it('ACT-89 signs every exchange with Basic over the pinned address, keeping the URL for TLS', async () => {
    const { fake, session } = await open();
    await session.run(COMMAND);
    const [first] = fake.requests;
    expect(first?.url).toBe(WINRM_URL);
    expect(first?.address).toBe(ADDRESS);
    expect(first?.method).toBe('POST');
    expect(first?.headers['authorization']).toBe(
      `Basic ${Buffer.from(`${WINRM_USERNAME}:${PASSWORD}`, 'utf8').toString('base64')}`,
    );
    expect(first?.headers['content-type']).toBe('application/soap+xml;charset=UTF-8');
    expect(first?.headers['user-agent']).toBe('vaultgate/9.9.9');
    expect(first?.certificate).toBeUndefined();
  });

  it('ACT-57 hands the transport a certificate check when the target pins one', async () => {
    const { fake, session } = await open({}, { certificateSha256: CERTIFICATE_SHA256 });
    await session.run(COMMAND);
    expect(typeof fake.requests[0]?.certificate).toBe('function');
  });

  it('ACT-28 names the shell in every exchange after Create and the command in every stream one', async () => {
    const { fake, session } = await open({ receives: [{ stdout: 'x', done: true }] });
    await session.run({ ...COMMAND, stdin: 'input' });
    await session.close();
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Send', 'Receive', 'Delete']);
    for (const body of fake.bodies.slice(1)) {
      expect(body).toContain(`<w:Selector Name="ShellId">${SHELL_ID}</w:Selector>`);
    }
    expect(fake.bodies[2]).toContain(
      `<rsp:Stream Name="stdin" CommandId="${COMMAND_ID}" End="true">${Buffer.from('input', 'utf8').toString('base64')}</rsp:Stream>`,
    );
    expect(fake.bodies[3]).toContain(`<rsp:DesiredStream CommandId="${COMMAND_ID}">`);
  });

  it('ACT-90 asks again when the shell answers TimedOut, which is not a failure', async () => {
    const { fake, session } = await open({
      receives: [{ timedOut: true }, { stdout: 'late', done: true, exitCode: 3 }],
    });
    const result = await session.run(COMMAND);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.toString('utf8')).toBe('late');
    expect(fake.actions.filter((action) => action === 'Receive')).toHaveLength(2);
  });

  it('ACT-59 ACT-90 the policy timeout terminates the command, then the shell is deleted', async () => {
    const { fake, session, controller } = await open({
      handler: (action) => (action === 'Receive' ? 'hang' : undefined),
    });
    const pending = session.run(COMMAND);
    await untilAction(fake, 'Receive');
    controller.abort();
    const timedOut = await errorOf(pending);
    expect(timedOut.code).toBe('timeout');
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Receive', 'Signal']);
    expect(fake.bodies[3]).toContain(
      `<rsp:Signal CommandId="${COMMAND_ID}"><rsp:Code>${TERMINATE}</rsp:Code></rsp:Signal>`,
    );
    await session.close();
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Receive', 'Signal', 'Delete']);
  });

  it('ACT-59 never opens a Receive when the deadline passed while the command was starting', async () => {
    const { fake, session, controller } = await open({ receives: [{ stdout: 'x' }] });
    const first = session.run(COMMAND);
    controller.abort();
    const timedOut = await errorOf(first);
    expect(timedOut.code).toBe('timeout');
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Signal']);
  });

  it('ACT-90 lets a Signal that fails pass, because Delete still ends the shell', async () => {
    const { fake, session, controller } = await open({
      handler: (action) => {
        if (action === 'Receive') {
          return 'hang';
        }
        return action === 'Signal' ? new Error('refused') : undefined;
      },
    });
    const pending = session.run(COMMAND);
    await untilAction(fake, 'Receive');
    controller.abort();
    const timedOut = await errorOf(pending);
    expect(timedOut.code).toBe('timeout');
    expect(fake.actions).toStrictEqual(['Create', 'Command', 'Receive', 'Signal']);
  });

  it('§13.16 answers authentication_failed for a 401, whichever exchange it answers', async () => {
    const unauthorised = new Response('', { status: 401 });
    const refused = await errorOf(open({ handler: () => unauthorised.clone() }));
    expect(refused.code).toBe('authentication_failed');
  });

  it('§13.16 answers upstream_error with the fault reason, and with the subcode when there is none', async () => {
    const faulted = await errorOf(
      open({
        handler: (action) =>
          action === 'Create' ? soapFault('AccessDenied', 'Access is denied.') : undefined,
      }),
    );
    expect(faulted.code).toBe('upstream_error');
    expect(faulted.detail).toStrictEqual({ message: 'Access is denied.' });
    const bare = await errorOf(
      open({
        handler: (action) => (action === 'Create' ? soapFault('InvalidSelectors', '') : undefined),
      }),
    );
    expect(bare.detail).toStrictEqual({ message: 'InvalidSelectors' });
  });

  it('T33 answers upstream_error for a body it cannot read and for a response with no shell id', async () => {
    const unreadable = await errorOf(
      open({ handler: () => new Response('<not xml', { status: 200 }) }),
    );
    expect(unreadable.code).toBe('upstream_error');
    expect(unreadable.detail).toStrictEqual({
      message: 'the destination sent a WS-Management response vaultgate could not read',
    });
    const empty = await errorOf(open({ handler: () => soapResponse('<rsp:Shell></rsp:Shell>') }));
    expect(empty.detail).toStrictEqual({
      message: 'the destination sent a WS-Management response vaultgate could not read',
    });
  });

  it('T33 answers upstream_error for a command response with no command id', async () => {
    const problem = await errorOf(
      (async () => {
        const { session } = await open({
          handler: (action) =>
            action === 'Command'
              ? soapResponse('<rsp:CommandResponse></rsp:CommandResponse>')
              : undefined,
        });
        return session.run(COMMAND);
      })(),
    );
    expect(problem.code).toBe('upstream_error');
  });

  it('§13.16 answers upstream_error naming the status when a response is neither 200 nor a fault', async () => {
    const problem = await errorOf(
      open({ handler: () => soapResponse('<rsp:Shell></rsp:Shell>', 503) }),
    );
    expect(problem.detail).toStrictEqual({ message: 'the destination answered HTTP 503' });
  });

  it('§13.16 answers upstream_error naming the status when a Receive is neither 200 nor a fault', async () => {
    const problem = await errorOf(
      (async () => {
        const { session } = await open({
          handler: (action) =>
            action === 'Receive'
              ? soapResponse('<rsp:ReceiveResponse></rsp:ReceiveResponse>', 503)
              : undefined,
        });
        return session.run(COMMAND);
      })(),
    );
    expect(problem.detail).toStrictEqual({ message: 'the destination answered HTTP 503' });
  });

  it('§13.16 answers upstream_error for a fault the shell raises mid-command', async () => {
    const problem = await errorOf(
      (async () => {
        const { session } = await open({
          handler: (action) =>
            action === 'Receive' ? soapFault('ShellQuota', 'quota exceeded') : undefined,
        });
        return session.run(COMMAND);
      })(),
    );
    expect(problem.detail).toStrictEqual({ message: 'quota exceeded' });
  });

  it('ACT-52 cuts each stream at the capture limit and says so', async () => {
    const { session } = await open({
      receives: [{ stdout: 'a'.repeat(40), stderr: 'b'.repeat(40), done: true }],
    });
    const result = await session.run({ ...COMMAND, captureBytes: 16 });
    expect(result.stdout.length).toBe(16);
    expect(result.stderr.length).toBe(16);
    expect(result.truncated).toBe(true);
  });

  it('ACT-27 reports a null exit code when the shell ended without one', async () => {
    const { session } = await open({
      handler: (action) =>
        action === 'Receive'
          ? soapResponse(
              '<rsp:ReceiveResponse><rsp:CommandState State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"></rsp:CommandState></rsp:ReceiveResponse>',
            )
          : undefined,
    });
    const result = await session.run(COMMAND);
    expect(result.exitCode).toBeNull();
  });
});
