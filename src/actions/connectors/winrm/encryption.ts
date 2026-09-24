/**
 * MS-WSMV 2.2.9.1 message encryption: the `multipart/encrypted` envelope a
 * Windows host expects on a plain listener, and which `AllowUnencrypted=false`
 * — the default — makes compulsory. The SOAP body is sealed with the NTLM
 * session key, and the part that carries it holds the signature length, the
 * signature and the sealed bytes, in that order.
 *
 * The response is read strictly (T33). The structure is walked line by line
 * with every line bounded, the sealed payload is located from the declared
 * plaintext length rather than by hunting for a boundary inside bytes the
 * destination chose, and a body that is not exactly this shape is refused —
 * the caller turns that into `upstream_error`. Nothing is decoded before the
 * signature has verified, and an unsigned or unencrypted body is never
 * accepted in place of one, which would be the downgrade the encryption
 * exists to prevent.
 */
import { Bytes, NtlmProblem } from './ntlm/reader.ts';

import type { NtlmSecurity } from './ntlm/security.ts';

const BOUNDARY = '--Encrypted Boundary';
const PROTOCOL = 'application/HTTP-SPNEGO-session-encrypted';
const OCTET_STREAM = 'application/octet-stream';
const SOAP_TYPE = 'application/soap+xml;charset=UTF-8';
const CRLF = '\r\n';

export const ENCRYPTED_CONTENT_TYPE = `multipart/encrypted;protocol="${PROTOCOL}";boundary="Encrypted Boundary"`;

const SIGNATURE_LENGTH_BYTES = 4;
/**
No header line of this envelope is long; the cap stops a destination making the reader walk a body.
*/
const MAX_LINE_BYTES = 512;

const DECLARED_LENGTH =
  /^\s*OriginalContent:\s*type=application\/soap\+xml;charset=UTF-8;Length=(\d{1,9})$/u;

export function wrapEncrypted(security: NtlmSecurity, soap: string): Buffer {
  const plain = Buffer.from(soap, 'utf8');
  const { signature, sealed } = security.seal(plain);
  const signatureLength = Buffer.alloc(SIGNATURE_LENGTH_BYTES);
  signatureLength.writeUInt32LE(signature.length, 0);
  const head = [
    BOUNDARY,
    `\tContent-Type: ${PROTOCOL}`,
    `\tOriginalContent: type=${SOAP_TYPE};Length=${plain.length}`,
    BOUNDARY,
    `\tContent-Type: ${OCTET_STREAM}`,
    '',
  ].join(CRLF);
  return Buffer.concat([
    Buffer.from(head, 'ascii'),
    signatureLength,
    signature,
    sealed,
    Buffer.from(`${BOUNDARY}--${CRLF}`, 'ascii'),
  ]);
}

interface Line {
  readonly text: string;
  readonly next: number;
}

function lineAt(body: Buffer, from: number): Line {
  const end = body.indexOf(CRLF, from, 'ascii');
  if (end === -1 || end - from > MAX_LINE_BYTES) {
    throw new NtlmProblem('a header line of the encrypted body does not end');
  }
  return { text: body.subarray(from, end).toString('latin1'), next: end + CRLF.length };
}

function expect(line: Line, isRight: (text: string) => boolean, what: string): Line {
  if (!isRight(line.text)) {
    throw new NtlmProblem(`the encrypted body does not carry ${what}`);
  }
  return line;
}

/**
The four header lines, ending at the byte where the sealed part begins.
*/
function readHead(body: Buffer): { readonly declared: number; readonly at: number } {
  const first = expect(lineAt(body, 0), (text) => text === BOUNDARY, 'its opening boundary');
  const protocol = expect(
    lineAt(body, first.next),
    (text) => text.includes(PROTOCOL),
    'the session-encrypted type',
  );
  const original = lineAt(body, protocol.next);
  const [, declared] = DECLARED_LENGTH.exec(original.text) ?? [];
  if (declared === undefined) {
    throw new NtlmProblem('the encrypted body declares no original content length');
  }
  const second = expect(
    lineAt(body, original.next),
    (text) => text === BOUNDARY,
    'a boundary before its sealed part',
  );
  const octet = expect(
    lineAt(body, second.next),
    (text) => text.includes(OCTET_STREAM),
    'an octet-stream part',
  );
  return { declared: Number(declared), at: octet.next };
}

export function unwrapEncrypted(security: NtlmSecurity, body: Buffer): string {
  const { declared, at } = readHead(body);
  const bytes = new Bytes(body);
  const signatureLength = bytes.u32(at, 'the signature length');
  const signature = bytes.slice(at + SIGNATURE_LENGTH_BYTES, signatureLength, 'the signature');
  const from = at + SIGNATURE_LENGTH_BYTES + signatureLength;
  const sealed = bytes.slice(from, declared, 'the sealed payload');
  const tail = body.subarray(from + declared).toString('latin1');
  // The closing boundary is sent with and without its line ending; nothing
  // else may follow the payload.
  if (tail !== `${BOUNDARY}--${CRLF}` && tail !== `${BOUNDARY}--`) {
    throw new NtlmProblem('the encrypted body does not end at its closing boundary');
  }
  return security.unseal(signature, sealed).toString('utf8');
}

/**
Whether a destination answered with the encrypted envelope at all, rather than something in the clear.
*/
export function isEncrypted(contentType: string | null): boolean {
  return contentType?.includes(PROTOCOL) === true;
}
