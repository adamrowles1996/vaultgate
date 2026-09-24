import { describe, expect, it } from 'vitest';

import { caller, errorOf, resultOf } from '../../../test-support/actions-fixtures.ts';
import { negotiating, type NegotiateOptions } from '../../../test-support/fake-wsman-negotiate.ts';
import {
  fakeWsman,
  soapResponse,
  type FakeWsman,
  type FakeWsmanOptions,
} from '../../../test-support/fake-wsman.ts';
import { surfaces } from '../../../test-support/http-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';
import {
  createWinrmTarget,
  harnessOverNegotiate,
  NEGOTIATE_TARGET,
  winrmInvocation,
  winrmSessionOverFake,
  NEGOTIATE_SESSION_KEY,
  WINRM_PLAIN_URL,
  WINRM_USERNAME,
} from '../../../test-support/winrm-connector.ts';
import { ActionError } from '../../errors.ts';
import { scrubVariants } from '../../scrub.ts';

import { at, parseXml } from './xml.ts';

import type { WinrmCommand, WinrmConnection, WinrmSession } from './session.ts';
import type { PinnedFetch } from '../../../net/pinned-https.ts';

const ADDRESS = '10.1.2.3';
/**
An NTLMSSP challenge cut off after its message type, which is what a truncated one looks like.
*/
const TRUNCATED_CHALLENGE = Buffer.concat([
  Buffer.from('NTLMSSP\u{0}', 'latin1'),
  Buffer.from('02000000', 'hex'),
]).toString('base64');
const WINRM = { scopes: ['actions:winrm'] } as const;
const COMMAND: WinrmCommand = {
  command: 'Get-ComputerInfo',
  stdin: undefined,
  captureBytes: 1024,
};

interface Opened {
  readonly fake: FakeWsman;
  readonly destination: ReturnType<typeof negotiating>;
  readonly session: WinrmSession;
}

function connection(overrides: Partial<WinrmConnection> = {}): WinrmConnection {
  return {
    url: WINRM_PLAIN_URL,
    address: ADDRESS,
    username: `DOMAIN\\${WINRM_USERNAME}`,
    password: CANARY.password,
    auth: 'negotiate',
    shell: 'powershell',
    certificateSha256: undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function open(
  options: FakeWsmanOptions = {},
  negotiateOptions: Partial<NegotiateOptions> = {},
  overrides: Partial<WinrmConnection> = {},
  wrap: (transport: PinnedFetch) => PinnedFetch = (transport) => transport,
): Promise<Opened> {
  const fake = fakeWsman(options);
  const destination = negotiating(fake, { password: CANARY.password, ...negotiateOptions });
  const session = await winrmSessionOverFake({ transport: wrap(destination.transport) })(
    connection(overrides),
  );
  return { fake, destination, session };
}

async function failureOf(run: Promise<unknown>): Promise<ActionError> {
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

/**
Replaces the destination's answer to one exchange, counted from the first request of the session.
*/
function replacing(inner: PinnedFetch, when: number, reply: () => Response): PinnedFetch {
  let index = -1;
  return async (request) => {
    index += 1;
    const answered = await inner(request);
    return index === when ? reply() : answered;
  };
}

/**
The local name of an envelope's `wsa:Action`, read with the connector's own strict reader.
*/
function actionOf(soap: string): string {
  const action = at(parseXml(soap), 'Header', 'Action')?.text ?? '';
  return action.slice(action.lastIndexOf('/') + 1);
}

describe('the winrm connector over Negotiate', () => {
  it('ACT-89 runs a command on a plain listener through a real NTLM exchange', async () => {
    const { destination, session } = await open({
      receives: [{ stdout: 'BUILD01', done: true, exitCode: 0 }],
    });
    const result = await session.run(COMMAND);
    await session.close();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString('utf8')).toBe('BUILD01');
    // The destination refuses a signature it cannot verify, so reading these
    // at all means every envelope was sealed and signed correctly, in order.
    expect(destination.plaintext.map((soap) => actionOf(soap))).toStrictEqual([
      'Create',
      'Command',
      'Receive',
      'Delete',
    ]);
  });

  it('ACT-89 sends every exchange of the session down one kept connection', async () => {
    const { destination, session } = await open();
    await session.run(COMMAND);
    await session.close();
    const [first] = destination.connections;
    expect(first).toBeDefined();
    expect(destination.connections.every((held) => held === first)).toBe(true);
    // The handshake is two requests; the shell adds four more.
    expect(destination.connections).toHaveLength(6);
  });

  it('ACT-89 keeps the sequence numbers straight across several receives in one shell', async () => {
    const { destination, session } = await open({
      receives: [
        { stdout: 'one' },
        { timedOut: true },
        { stdout: ' two' },
        { stdout: ' three', done: true, exitCode: 0 },
      ],
    });
    const result = await session.run(COMMAND);
    await session.close();
    expect(result.stdout.toString('utf8')).toBe('one two three');
    expect(destination.plaintext).toHaveLength(7);
  });

  it('§13.16 answers authentication_failed when the destination rejects the password', async () => {
    const refused = await failureOf(open({}, { password: 'canary-a-different-password' }));
    expect(refused.code).toBe('authentication_failed');
  });

  it('§13.16 answers authentication_failed when a later exchange is challenged again', async () => {
    const problem = await failureOf(
      open({}, {}, {}, (transport) =>
        replacing(transport, 2, () => new Response('', { status: 401 })),
      ),
    );
    expect(problem.code).toBe('authentication_failed');
  });

  it('T33 answers upstream_error for a challenge that is truncated or malformed', async () => {
    const problem = await failureOf(
      open({}, {}, {}, (transport) =>
        replacing(
          transport,
          0,
          () =>
            new Response('', {
              status: 401,
              headers: { 'www-authenticate': `Negotiate ${TRUNCATED_CHALLENGE}` },
            }),
        ),
      ),
    );
    expect(problem.code).toBe('upstream_error');
    expect(String(problem.detail?.['message'])).toContain('is not readable');
  });

  it('T33 answers upstream_error when the destination offers no challenge at all', async () => {
    const problem = await failureOf(
      open({}, {}, {}, (transport) =>
        replacing(transport, 0, () => new Response('', { status: 401 })),
      ),
    );
    expect(problem.code).toBe('upstream_error');
    expect(String(problem.detail?.['message'])).toContain('no Negotiate challenge');
  });

  it('T33 answers upstream_error for a reply whose signature was tampered with', async () => {
    const problem = await failureOf(
      open(
        {},
        {
          tamper: (body) => {
            const offset = body.toString('latin1').indexOf('application/octet-stream\r\n') + 30;
            const broken = Buffer.from(body);
            broken.writeUInt8(broken.readUInt8(offset) ^ 0xff, offset);
            return broken;
          },
        },
      ),
    );
    expect(problem.code).toBe('upstream_error');
    expect(String(problem.detail?.['message'])).toContain('signature does not match');
  });

  it('T33 answers upstream_error for a reply whose multipart shape is wrong', async () => {
    const problem = await failureOf(
      open({}, { tamper: (body) => Buffer.concat([Buffer.from('rubbish'), body]) }),
    );
    expect(problem.code).toBe('upstream_error');
  });

  it('ACT-89 refuses an answer the destination sent in the clear on a plain listener', async () => {
    const problem = await failureOf(
      open({}, {}, {}, (transport) =>
        replacing(transport, 2, () =>
          soapResponse('<rsp:Shell><rsp:ShellId>x</rsp:ShellId></rsp:Shell>'),
        ),
      ),
    );
    expect(problem.code).toBe('upstream_error');
    expect(problem.detail).toStrictEqual({
      message: 'the destination answered HTTP 200 without the message encryption it requires',
    });
  });

  it('ACT-89 sends the envelope unsealed over TLS, where the transport already encrypts it', async () => {
    const { destination, session } = await open(
      { receives: [{ stdout: 'over tls', done: true }] },
      { sealed: false },
      { url: 'https://win.example.com:5986/wsman' },
    );
    const result = await session.run(COMMAND);
    await session.close();
    expect(result.stdout.toString('utf8')).toBe('over tls');
    expect(destination.plaintext[0]).toContain('<s:Envelope');
  });
});

describe('the winrm connector over Negotiate, through the engine', () => {
  it('ACT-89 ACT-56 runs on an internal plain target and records the call', async () => {
    const { harness } = harnessOverNegotiate({
      receives: [{ stdout: 'BUILD01', done: true, exitCode: 0 }],
    });
    await createWinrmTarget(harness, NEGOTIATE_TARGET);
    const result = resultOf(await harness.engine.call(caller(WINRM), winrmInvocation()));
    expect(result).toMatchObject({ exit_code: 0, stdout: 'BUILD01', truncated: false });
  });

  it('ACT-75 ACT-51 neither the password nor the session key reaches any surface', async () => {
    const echoed = [
      CANARY.password,
      Buffer.from(CANARY.password, 'utf8').toString('base64'),
      encodeURIComponent(CANARY.password),
    ].join('\n');
    const { harness } = harnessOverNegotiate({
      receives: [{ stdout: echoed, done: true, exitCode: 0 }],
    });
    await createWinrmTarget(harness, NEGOTIATE_TARGET);
    const result = resultOf(await harness.engine.call(caller(WINRM), winrmInvocation()));
    expect(result['stdout']).toBe('[redacted:password]\n[redacted:password]\n[redacted:password]');
    const everything = surfaces(harness, [result]);
    expect(
      scrubVariants(CANARY.password, WINRM_USERNAME).filter((variant) =>
        everything.includes(variant),
      ),
    ).toStrictEqual([]);
    for (const encoding of ['hex', 'base64', 'latin1'] as const) {
      expect(everything).not.toContain(NEGOTIATE_SESSION_KEY.toString(encoding));
    }
  });

  it('§13.16 answers authentication_failed to the agent when the password is wrong', async () => {
    const { harness } = harnessOverNegotiate({}, { password: 'canary-a-different-password' });
    await createWinrmTarget(harness, NEGOTIATE_TARGET);
    const error = errorOf(await harness.engine.call(caller(WINRM), winrmInvocation()));
    expect(error.code).toBe('authentication_failed');
  });
});
