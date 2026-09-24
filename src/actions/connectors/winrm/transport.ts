/**
 * How one SOAP envelope reaches the destination (ACT-89). Two ways, chosen by
 * the target's `auth`:
 *
 * - `basic` sends `Authorization: Basic base64(user:password)` and the
 *   envelope in the clear, which is safe only because the endpoint is HTTPS —
 *   the save-time check refuses the pair on a plain URL.
 * - `negotiate` performs the NTLM exchange of `./ntlm/`, after which the
 *   password has never crossed the network and a session key exists. On a
 *   plain endpoint every envelope after that is sealed into the
 *   `multipart/encrypted` form of `./encryption.ts`, which is exactly what a
 *   host with `AllowUnencrypted=false` — the Windows default — requires; on an
 *   HTTPS endpoint the transport already encrypts and MS-WSMV sends the
 *   envelope as it is.
 *
 * NTLM authenticates the connection, so a negotiating session holds one socket
 * from the handshake until `release`.
 */
import { KeptConnection } from '../../../net/kept-connection.ts';
import { readBodyCapped } from '../../../net/pinned-https.ts';
import { ActionError } from '../../errors.ts';

import {
  ENCRYPTED_CONTENT_TYPE,
  isEncrypted,
  unwrapEncrypted,
  wrapEncrypted,
} from './encryption.ts';
import { UNAUTHORIZED } from './failures.ts';
import { startNtlm } from './ntlm/handshake.ts';
import { ntlmCredential } from './ntlm/ntlmv2.ts';
import { NtlmProblem } from './ntlm/reader.ts';

import type { NtlmSecurity } from './ntlm/security.ts';
import type { WinrmConnection, WinrmDependencies } from './session.ts';
import type { CertificateCheck } from '../../../net/certificate-pin.ts';

/**
 * Well above the `MaxEnvelopeSize` the shell is created with, so a response
 * that respects it always fits and one that does not is cut and reported as
 * unreadable rather than buffered without limit (T33).
 */
const MAX_RESPONSE_BYTES = 512 * 1024;

const SOAP_CONTENT_TYPE = 'application/soap+xml;charset=UTF-8';
const EMPTY = Buffer.alloc(0);

export interface SoapAnswer {
  readonly text: string;
  readonly status: number;
}

export interface WinrmTransport {
  send(body: string, signal: AbortSignal): Promise<SoapAnswer>;
  /**
  Drops anything the session held; a `basic` session holds nothing.
  */
  release(): void;
}

interface RawAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Buffer;
}

interface Wire {
  readonly connection: WinrmConnection;
  readonly dependencies: WinrmDependencies;
  readonly certificate: CertificateCheck | undefined;
  readonly kept: KeptConnection | undefined;
}

/**
 * A reader of the NTLM and multipart parsers: what they refuse is a malformed
 * answer from the destination (T33), which is `upstream_error` and never an
 * uncaught exception. The message is vaultgate's own words, so there is no
 * upstream text in it.
 */
export function readNtlm<Value>(reader: () => Value): Value {
  try {
    return reader();
  } catch (error) {
    if (error instanceof NtlmProblem) {
      throw new ActionError('upstream_error', { message: error.message });
    }
    throw error;
  }
}

async function post(
  wire: Wire,
  headers: Readonly<Record<string, string>>,
  body: Buffer,
  signal: AbortSignal,
): Promise<RawAnswer> {
  const response = await wire.dependencies.transport({
    url: wire.connection.url,
    address: wire.connection.address,
    method: 'POST',
    headers: { 'user-agent': `vaultgate/${wire.dependencies.version}`, ...headers },
    body,
    signal,
    certificate: wire.certificate,
    connection: wire.kept,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await readBodyCapped(response, MAX_RESPONSE_BYTES),
  };
}

function basicTransport(wire: Wire): WinrmTransport {
  const pair = `${wire.connection.username}:${wire.connection.password}`;
  const headers = {
    'content-type': SOAP_CONTENT_TYPE,
    authorization: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`,
  };
  return {
    async send(body, signal) {
      const answer = await post(wire, headers, Buffer.from(body, 'utf8'), signal);
      if (answer.status === UNAUTHORIZED) {
        throw new ActionError('authentication_failed');
      }
      return { text: answer.body.toString('utf8'), status: answer.status };
    },
    release() {
      // A `basic` session holds no connection of its own.
    },
  };
}

/**
 * MS-WSMV 3.1.4.1.11: the two-round handshake. The first request carries the
 * negotiate message and no body and is answered with `401` and the challenge;
 * the second carries the authenticate message, and a `401` to *that* is the
 * destination rejecting the credential.
 */
async function handshake(wire: Wire, signal: AbortSignal): Promise<NtlmSecurity> {
  const exchange = startNtlm({
    credential: ntlmCredential(wire.connection.username, wire.connection.password),
    random: wire.dependencies.random,
    now: wire.dependencies.now,
  });
  const challenged = await post(
    wire,
    { 'content-type': SOAP_CONTENT_TYPE, authorization: exchange.authorization },
    EMPTY,
    signal,
  );
  const answer = readNtlm(() => exchange.answer(challenged.headers.get('www-authenticate')));
  const accepted = await post(
    wire,
    { 'content-type': SOAP_CONTENT_TYPE, authorization: answer.authorization },
    EMPTY,
    signal,
  );
  if (accepted.status === UNAUTHORIZED) {
    throw new ActionError('authentication_failed');
  }
  return answer.security;
}

function sealedAnswer(security: NtlmSecurity, answer: RawAnswer): SoapAnswer {
  if (!isEncrypted(answer.headers.get('content-type'))) {
    throw new ActionError('upstream_error', {
      message: `the destination answered HTTP ${answer.status} without the message encryption it requires`,
    });
  }
  return {
    text: readNtlm(() => unwrapEncrypted(security, answer.body)),
    status: answer.status,
  };
}

function negotiateTransport(wire: Wire, isSealed: boolean): WinrmTransport {
  let security: NtlmSecurity | undefined;
  return {
    async send(body, signal) {
      security ??= await handshake(wire, signal);
      const answer = await post(
        wire,
        { 'content-type': isSealed ? ENCRYPTED_CONTENT_TYPE : SOAP_CONTENT_TYPE },
        isSealed ? wrapEncrypted(security, body) : Buffer.from(body, 'utf8'),
        signal,
      );
      if (answer.status === UNAUTHORIZED) {
        throw new ActionError('authentication_failed');
      }
      return isSealed
        ? sealedAnswer(security, answer)
        : { text: answer.body.toString('utf8'), status: answer.status };
    },
    release() {
      wire.kept?.release();
    },
  };
}

export function openTransport(
  connection: WinrmConnection,
  dependencies: WinrmDependencies,
  certificate: CertificateCheck | undefined,
): WinrmTransport {
  if (connection.auth === 'basic') {
    return basicTransport({ connection, dependencies, certificate, kept: undefined });
  }
  const wire: Wire = { connection, dependencies, certificate, kept: new KeptConnection() };
  return negotiateTransport(wire, new URL(connection.url).protocol === 'http:');
}
