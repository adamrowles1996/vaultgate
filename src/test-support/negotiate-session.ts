/**
 * One `winrm` session opened over the fake `Negotiate` destination (ACT-75,
 * ACT-89): the real connector, a real NTLM exchange, and the scripted
 * WS-Management fake behind it, with no socket and no Windows host. Both
 * `negotiate.test.ts` and `negotiate-binding.test.ts` drive the connector
 * through this, so the two read the same way.
 */
import { ActionError } from '../actions/errors.ts';

import { negotiating, type FakeNegotiate, type NegotiateOptions } from './fake-wsman-negotiate.ts';
import { fakeWsman, type FakeWsman, type FakeWsmanOptions } from './fake-wsman.ts';
import { CANARY } from './vault-fixture.ts';
import { winrmSessionOverFake, WINRM_PLAIN_URL, WINRM_USERNAME } from './winrm-connector.ts';

import type {
  WinrmCommand,
  WinrmConnection,
  WinrmSession,
} from '../actions/connectors/winrm/session.ts';
import type { PinnedFetch } from '../net/pinned-https.ts';

/**
ACT-55: the address the engine resolved for the destination; the socket goes there.
*/
export const NEGOTIATE_ADDRESS = '10.1.2.3';

export const NEGOTIATE_COMMAND: WinrmCommand = {
  command: 'Get-ComputerInfo',
  stdin: undefined,
  captureBytes: 1024,
};

export interface OpenedNegotiate {
  readonly fake: FakeWsman;
  readonly destination: FakeNegotiate;
  readonly session: WinrmSession;
}

export interface OpenNegotiate {
  readonly wsman?: FakeWsmanOptions;
  readonly destination?: Partial<NegotiateOptions>;
  readonly connection?: Partial<WinrmConnection>;
  /**
  Wraps the destination's transport, for the cases that replace one exchange's answer.
  */
  readonly wrap?: (transport: PinnedFetch) => PinnedFetch;
}

export function negotiateConnection(overrides: Partial<WinrmConnection> = {}): WinrmConnection {
  return {
    url: WINRM_PLAIN_URL,
    address: NEGOTIATE_ADDRESS,
    username: `DOMAIN\\${WINRM_USERNAME}`,
    password: CANARY.password,
    auth: 'negotiate',
    shell: 'powershell',
    certificateSha256: undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export async function openNegotiate(options: OpenNegotiate = {}): Promise<OpenedNegotiate> {
  const fake = fakeWsman(options.wsman ?? {});
  const destination = negotiating(fake, { password: CANARY.password, ...options.destination });
  const transport = options.wrap?.(destination.transport) ?? destination.transport;
  const session = await winrmSessionOverFake({ transport })(
    negotiateConnection(options.connection),
  );
  return { fake, destination, session };
}

/**
The `ActionError` a failed open or call answers with; anything else travels as itself.
*/
export async function negotiateFailure(run: Promise<unknown>): Promise<ActionError> {
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
