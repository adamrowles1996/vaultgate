/**
 * A WS-Management destination that speaks `Negotiate` (ACT-75, ACT-89): the
 * NTLM server of `./fake-ntlm.ts` in front of the scripted WS-Management fake
 * of `./fake-wsman.ts`, with the MS-WSMV `multipart/encrypted` envelope on a
 * plain endpoint exactly as a Windows host with `AllowUnencrypted=false`
 * demands.
 *
 * It refuses anything the connector gets wrong — an unverifiable signature, a
 * message out of sequence, an unencrypted body — so a contract test that
 * passes has really performed the exchange. No test needs a Windows host.
 */
import { FakeNtlm, type FakeNtlmOptions, type FakeSecurity } from './fake-ntlm.ts';

import type { FakeWsman } from './fake-wsman.ts';
import type { PinnedFetch, PinnedRequest } from '../net/pinned-https.ts';

const BOUNDARY = '--Encrypted Boundary';
const PROTOCOL = 'application/HTTP-SPNEGO-session-encrypted';
const ENCRYPTED = `multipart/encrypted;protocol="${PROTOCOL}";boundary="Encrypted Boundary"`;
const NEGOTIATE = 'Negotiate ';

export interface NegotiateOptions extends FakeNtlmOptions {
  /**
  Whether the destination requires the encrypted envelope; a plain listener does.
  */
  readonly sealed?: boolean;
  /**
  Rewrites the destination's encrypted reply, for the tampering case.
  */
  readonly tamper?: (body: Buffer) => Buffer;
}

export interface FakeNegotiate {
  readonly transport: PinnedFetch;
  /**
  The kept connection each request travelled, so a test can prove they shared one socket.
  */
  readonly connections: unknown[];
  /**
  What the destination received as plaintext SOAP, in order.
  */
  readonly plaintext: string[];
}

function unwrap(body: Buffer, security: FakeSecurity): string {
  const text = body.toString('latin1');
  const start = text.indexOf(`${BOUNDARY}\r\n\tContent-Type: application/octet-stream\r\n`);
  const declared = /Length=(\d+)/u.exec(text);
  if (start === -1 || declared === null) {
    throw new Error('the client did not send the multipart/encrypted envelope');
  }
  const at = start + `${BOUNDARY}\r\n\tContent-Type: application/octet-stream\r\n`.length;
  const signatureLength = body.readUInt32LE(at);
  const signature = body.subarray(at + 4, at + 4 + signatureLength);
  const sealed = body.subarray(
    at + 4 + signatureLength,
    at + 4 + signatureLength + Number(declared[1]),
  );
  return security.fromClient(signature, sealed).toString('utf8');
}

function wrap(soap: string, security: FakeSecurity): Buffer {
  const plain = Buffer.from(soap, 'utf8');
  const { signature, sealed } = security.toClient(plain);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signature.length, 0);
  const head = [
    BOUNDARY,
    `\tContent-Type: ${PROTOCOL}`,
    `\tOriginalContent: type=application/soap+xml;charset=UTF-8;Length=${plain.length}`,
    BOUNDARY,
    '\tContent-Type: application/octet-stream',
    '',
  ].join('\r\n');
  return Buffer.concat([
    Buffer.from(head, 'ascii'),
    length,
    signature,
    sealed,
    Buffer.from(`${BOUNDARY}--\r\n`, 'ascii'),
  ]);
}

function unauthorised(challenge: Buffer | undefined): Response {
  return new Response('', {
    status: 401,
    headers: {
      'www-authenticate':
        challenge === undefined ? 'Negotiate' : `${NEGOTIATE}${challenge.toString('base64')}`,
    },
  });
}

/**
 * The scripted WS-Management answer to one plaintext envelope, sealed back up
 * where the destination requires it.
 */
async function answer(
  inner: FakeWsman,
  sent: { readonly request: PinnedRequest; readonly soap: string },
  security: FakeSecurity,
  options: NegotiateOptions,
): Promise<Response> {
  const reply = await inner.transport({ ...sent.request, body: Buffer.from(sent.soap, 'utf8') });
  const text = await reply.text();
  if (options.sealed === false) {
    return new Response(text, { status: reply.status, headers: reply.headers });
  }
  const wrapped = wrap(text, security);
  return new Response(options.tamper?.(wrapped) ?? wrapped, {
    status: reply.status,
    headers: { 'content-type': ENCRYPTED },
  });
}

export function negotiating(inner: FakeWsman, options: NegotiateOptions): FakeNegotiate {
  const server = new FakeNtlm(options);
  const connections: unknown[] = [];
  const plaintext: string[] = [];
  let security: FakeSecurity | undefined;
  const transport: PinnedFetch = async (request) => {
    connections.push(request.connection);
    const authorization = request.headers['authorization'];
    if (authorization?.startsWith(NEGOTIATE) === true) {
      const token = Buffer.from(authorization.slice(NEGOTIATE.length), 'base64');
      if (token.readUInt32LE(8) === 1) {
        return unauthorised(server.challenge(token));
      }
      security = server.accept(token);
      return security === undefined ? unauthorised(undefined) : new Response('', { status: 200 });
    }
    if (security === undefined) {
      return unauthorised(undefined);
    }
    const sent = Buffer.from(request.body ?? '');
    const soap = options.sealed === false ? sent.toString('utf8') : unwrap(sent, security);
    plaintext.push(soap);
    return answer(inner, { request, soap }, security, options);
  };
  return { transport, connections, plaintext };
}
