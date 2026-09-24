import { describe, expect, it } from 'vitest';

import { FakeNtlm } from '../../../../test-support/fake-ntlm.ts';

import { challengeToken, negotiateHeader, startNtlm } from './handshake.ts';
import { negotiateMessage } from './negotiate.ts';
import { NtlmProblem } from './reader.ts';

const PASSWORD = 'canary-winrm-password';

function header(challenge: Buffer): string {
  return `Negotiate ${challenge.toString('base64')}`;
}

function handshake(): ReturnType<typeof startNtlm> {
  return startNtlm({
    credential: { username: 'vaultgate', domain: '', password: PASSWORD },
    random: (bytes) => Buffer.alloc(bytes, 0xaa),
    now: () => 0,
  });
}

describe('the NTLM handshake over HTTP', () => {
  it('ACT-89 opens with the negotiate message base64 under the Negotiate scheme', () => {
    const exchange = handshake();
    expect(exchange.authorization).toBe(negotiateHeader(negotiateMessage()));
    expect(Buffer.from(exchange.authorization.slice('Negotiate '.length), 'base64')).toStrictEqual(
      negotiateMessage(),
    );
  });

  it('ACT-89 answers a challenge with an authenticate message the destination accepts', () => {
    const server = new FakeNtlm({ password: PASSWORD, timestamped: true });
    const exchange = handshake();
    const challenge = server.challenge(
      Buffer.from(exchange.authorization.slice('Negotiate '.length), 'base64'),
    );
    const answer = exchange.answer(header(challenge));
    const accepted = server.accept(
      Buffer.from(answer.authorization.slice('Negotiate '.length), 'base64'),
    );
    expect(accepted).toBeDefined();
    const sent = answer.security.seal(Buffer.from('<s:Envelope/>', 'utf8'));
    expect(accepted?.fromClient(sent.signature, sent.sealed).toString('utf8')).toBe(
      '<s:Envelope/>',
    );
  });

  it('T33 picks the Negotiate offer out of a header that lists several schemes', () => {
    const token = Buffer.from('NTLMSSP\u{0}', 'latin1').toString('base64');
    expect(challengeToken(`Kerberos, Negotiate ${token}`)).toStrictEqual(
      Buffer.from(token, 'base64'),
    );
    expect(challengeToken(`negotiate ${token}`)).toHaveLength(8);
  });

  it('T33 refuses a header that carries no challenge, or one that is not base64', () => {
    for (const offered of [null, '', 'Negotiate', 'Basic realm="x"', 'Negotiate not base64!']) {
      expect(() => challengeToken(offered)).toThrow(NtlmProblem);
    }
    expect(() => challengeToken('Negotiate')).toThrow(
      'it offered no Negotiate challenge to answer',
    );
  });

  it('T33 refuses a challenge the destination sent that is not a readable NTLM message', () => {
    expect(() => handshake().answer(header(Buffer.from('nonsense', 'utf8')))).toThrow(NtlmProblem);
  });
});
