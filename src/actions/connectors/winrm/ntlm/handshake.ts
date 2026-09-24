/**
 * NTLM as HTTP carries it (MS-WSMV 3.1.4.1.11, RFC 4559): the three messages
 * ride base64 in `Authorization: Negotiate …` and `WWW-Authenticate:
 * Negotiate …`, and the exchange authenticates the *connection*, which is why
 * the transport holds one socket for the length of a session.
 *
 * The header a destination answers with is attacker-reachable input (T33):
 * it is picked apart by exact scheme name, checked against the base64
 * alphabet before it is decoded, and refused as an `NtlmProblem` if it is
 * anything else — including the bare `Negotiate` with no token that a server
 * offers before it has been asked anything.
 */
import { authenticateMessage } from './authenticate.ts';
import { parseChallenge } from './challenge.ts';
import { channelBindingToken } from './channel-binding.ts';
import { negotiateMessage } from './negotiate.ts';
import { NtlmProblem } from './reader.ts';
import { NtlmSecurity } from './security.ts';

import type { NtlmCredential } from './ntlmv2.ts';

const SCHEME = 'negotiate';
const BASE64 = /^[\d+/A-Za-z]+={0,2}$/u;

export interface NtlmStart {
  readonly credential: NtlmCredential;
  /**
   * The leaf certificate the connection's peer presented, read when the third
   * message is built because that is the first moment the socket has one.
   * `undefined` on a plain `http://` connection, where there is no channel to
   * bind the exchange to and the pair is left out (RFC 5929).
   */
  readonly certificate: () => Buffer | undefined;
  readonly random: (bytes: number) => Buffer;
  readonly now: () => number;
}

export interface NtlmAnswer {
  /**
  The `Authorization` value carrying the third message.
  */
  readonly authorization: string;
  readonly security: NtlmSecurity;
}

export interface NtlmHandshake {
  /**
  The `Authorization` value carrying the first message.
  */
  readonly authorization: string;
  /**
  Reads the destination's `WWW-Authenticate` and answers it, establishing the session security.
  */
  answer(header: string | null): NtlmAnswer;
}

export function negotiateHeader(message: Buffer): string {
  return `Negotiate ${message.toString('base64')}`;
}

/**
The challenge a `WWW-Authenticate` header carries; the header may list other schemes beside it.
*/
export function challengeToken(header: string | null): Buffer {
  const token = (header ?? '')
    .split(',')
    .map((offer) => offer.trim())
    .find((offer) => offer.toLowerCase().startsWith(`${SCHEME} `))
    ?.slice(SCHEME.length + 1)
    .trim();
  if (token === undefined || !BASE64.test(token)) {
    throw new NtlmProblem('it offered no Negotiate challenge to answer');
  }
  return Buffer.from(token, 'base64');
}

export function startNtlm(start: NtlmStart): NtlmHandshake {
  const negotiate = negotiateMessage();
  return {
    authorization: negotiateHeader(negotiate),
    answer(header) {
      const certificate = start.certificate();
      const authentication = authenticateMessage({
        credential: start.credential,
        challenge: parseChallenge(challengeToken(header)),
        negotiate,
        channelBinding: certificate === undefined ? undefined : channelBindingToken(certificate),
        random: start.random,
        now: start.now,
      });
      return {
        authorization: negotiateHeader(authentication.message),
        security: new NtlmSecurity(authentication.exportedSessionKey, authentication.isKeyExchange),
      };
    },
  };
}
