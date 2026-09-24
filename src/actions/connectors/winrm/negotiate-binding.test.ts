import { describe, expect, it } from 'vitest';

import {
  negotiateFailure,
  openNegotiate,
  NEGOTIATE_COMMAND,
} from '../../../test-support/negotiate-session.ts';
import { WINRM_URL } from '../../../test-support/winrm-connector.ts';

/**
 * The leaf certificate the fake destination presents on its TLS connection,
 * and one it does not. The destination records the first on the kept
 * connection, the way a TLS socket does, rather than handing it to the
 * connector — so a token computed from it proves the connector read the
 * certificate of the socket it was really talking over.
 */
const LEAF = Buffer.from('canary-leaf-certificate-der', 'utf8');
const OTHER_LEAF = Buffer.from('canary-other-certificate-der', 'utf8');

describe('the winrm connector binding an NTLM exchange to its TLS channel', () => {
  it('ACT-89 binds the exchange to the certificate the TLS connection presented', async () => {
    // The destination demands the binding, as `CbtHardeningLevel = Strict` does.
    const { destination, session } = await openNegotiate({
      wsman: { receives: [{ stdout: 'bound', done: true }] },
      destination: { sealed: false, presents: LEAF, channelBinding: LEAF },
      connection: { url: WINRM_URL },
    });
    const result = await session.run(NEGOTIATE_COMMAND);
    await session.close();
    expect(result.stdout.toString('utf8')).toBe('bound');
    expect(destination.channelBinding()).toHaveLength(16);
  });

  it('ACT-89 T35 is refused by a TLS destination that expects a different certificate', async () => {
    // A relay: the connector's socket presented one certificate and the host
    // at the far end checks for another. One token cannot satisfy both.
    const refused = await negotiateFailure(
      openNegotiate({
        destination: { sealed: false, presents: LEAF, channelBinding: OTHER_LEAF },
        connection: { url: WINRM_URL },
      }),
    );
    expect(refused.code).toBe('authentication_failed');
  });

  it('ACT-89 is refused by a destination that requires a binding when there is no TLS', async () => {
    const refused = await negotiateFailure(
      openNegotiate({ destination: { channelBinding: LEAF } }),
    );
    expect(refused.code).toBe('authentication_failed');
  });

  it('ACT-89 sends no channel binding over a plain listener, which has no channel to bind to', async () => {
    const { destination, session } = await openNegotiate();
    await session.close();
    expect(destination.channelBinding()).toBeUndefined();
  });
});
