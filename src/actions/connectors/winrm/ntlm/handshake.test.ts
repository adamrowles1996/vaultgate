import { describe, expect, it } from 'vitest';

import { FakeNtlm } from '../../../../test-support/fake-ntlm.ts';

import { challengeToken, negotiateHeader, startNtlm } from './handshake.ts';
import { negotiateMessage } from './negotiate.ts';
import { NtlmProblem } from './reader.ts';

const PASSWORD = 'canary-winrm-password';
const LEAF = Buffer.from('canary-leaf-certificate-der', 'utf8');
const OTHER = Buffer.from('canary-other-certificate-der', 'utf8');

function header(challenge: Buffer): string {
  return `Negotiate ${challenge.toString('base64')}`;
}

function handshake(certificate?: Buffer): ReturnType<typeof startNtlm> {
  return startNtlm({
    credential: { username: 'vaultgate', domain: '', password: PASSWORD },
    certificate: () => certificate,
    random: (bytes) => Buffer.alloc(bytes, 0xaa),
    now: () => 0,
  });
}

function answerOf(exchange: ReturnType<typeof startNtlm>, server: FakeNtlm): Buffer {
  const challenge = server.challenge(
    Buffer.from(exchange.authorization.slice('Negotiate '.length), 'base64'),
  );
  return Buffer.from(
    exchange.answer(header(challenge)).authorization.slice('Negotiate '.length),
    'base64',
  );
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

  it('ACT-89 binds the exchange to the certificate the connection presented, over TLS', () => {
    const certificate = Buffer.from('canary-leaf-certificate-der', 'utf8');
    const server = new FakeNtlm({
      password: PASSWORD,
      timestamped: true,
      channelBinding: certificate,
    });
    const answer = answerOf(handshake(certificate), server);
    expect(server.accept(answer)).toBeDefined();
  });

  it('ACT-89 is refused by a destination that expects a different connection certificate', () => {
    const server = new FakeNtlm({ password: PASSWORD, timestamped: true, channelBinding: OTHER });
    const answer = answerOf(handshake(LEAF), server);
    expect(server.accept(answer)).toBeUndefined();
  });

  it('ACT-89 sends no channel binding on a plain connection, and a plain destination wants none', () => {
    const server = new FakeNtlm({ password: PASSWORD, timestamped: true });
    const answer = answerOf(handshake(), server);
    expect(server.accept(answer)).toBeDefined();
    expect(server.channelBinding).toBeUndefined();
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
