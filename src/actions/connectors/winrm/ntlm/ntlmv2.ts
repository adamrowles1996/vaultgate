/**
 * The NTLMv2 response (MS-NLMP 3.3.2), which is the whole reason this
 * connector can reach a Windows host without sending a password: the client
 * proves it knows `MD4(UTF-16LE(password))` by answering a challenge the
 * server chose, and what crosses the network is an HMAC over that challenge
 * and a client-chosen one, never the secret itself.
 *
 * `ntlmv2.test.ts` checks every value here against the worked example in
 * MS-NLMP 4.2.4, so the arithmetic is proved against the specification rather
 * than against vaultgate's own fake destination.
 */
import { createHmac } from 'node:crypto';

import { md4 } from '../../../../crypto/md4.ts';

export interface NtlmCredential {
  /**
  The login name as the operator wrote it, without the domain part.
  */
  readonly username: string;
  /**
  `HOST` of `HOST\user`, or empty for a bare name; MS-NLMP does not upper-case it.
  */
  readonly domain: string;
  readonly password: string;
}

export interface Ntlmv2Request {
  /**
  `NTOWFv2`: the key every other value in the exchange hangs from.
  */
  readonly key: Buffer;
  readonly serverChallenge: Buffer;
  readonly clientChallenge: Buffer;
  /**
  The `temp` blob of MS-NLMP 3.3.2 — version, timestamp, client challenge and the server's attributes.
  */
  readonly blob: Buffer;
  /**
  MS-NLMP 3.1.5.1.2: with a server timestamp the LM response is zeroed and the MIC carries the proof.
  */
  readonly isTimestamped: boolean;
}

export interface Ntlmv2Response {
  readonly nt: Buffer;
  readonly lm: Buffer;
  readonly sessionBaseKey: Buffer;
}

const BLOB_HEADER = Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]);
const RESERVED_BYTES = 4;
const LM_RESPONSE_BYTES = 24;

/**
 * The FILETIME epoch is 1601-01-01 and its unit is 100 nanoseconds; both
 * differences are exact in `bigint`, which is why the conversion is not done
 * in doubles.
 */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const FILETIME_PER_MS = 10_000n;
const FILETIME_BYTES = 8;

/**
 * HMAC-MD5, which is what MS-NLMP builds every value of the exchange with.
 * CodeQL reports this as a weak algorithm (`js/weak-cryptographic-algorithm`)
 * and it is right about MD5; it is here because the protocol is defined in
 * terms of it and a client that computes anything else cannot speak NTLM.
 * See the header of `src/crypto/md4.ts` and ACT-89 for what actually protects
 * the exchange, which is not this digest's collision resistance.
 */
export function hmacMd5(key: Buffer, data: Buffer): Buffer {
  return createHmac('md5', key).update(data).digest();
}

/**
MS-NLMP 3.3.2: `HMAC_MD5(MD4(UTF-16LE(password)), UTF-16LE(UPPER(user) + domain))`.
*/
export function ntowfv2(credential: NtlmCredential): Buffer {
  const ntHash = md4(Buffer.from(credential.password, 'utf16le'));
  const identity = Buffer.from(credential.username.toUpperCase() + credential.domain, 'utf16le');
  return hmacMd5(ntHash, identity);
}

/**
 * The account as the operator wrote it in the destination. A bare name is a
 * local account on the destination itself, which is what a workgroup Windows
 * machine has; `HOST\\user` or `DOMAIN\\user` names the authority the name
 * belongs to, and NTLM carries that separately. A `user@domain` name is passed
 * through whole, which is how Windows expects a user principal name.
 */
export function ntlmCredential(login: string, password: string): NtlmCredential {
  const separator = login.indexOf('\\');
  return separator === -1
    ? { username: login, domain: '', password }
    : { username: login.slice(separator + 1), domain: login.slice(0, separator), password };
}

export function fileTime(epochMilliseconds: number): Buffer {
  const time = Buffer.alloc(FILETIME_BYTES);
  time.writeBigUInt64LE(
    (BigInt(Math.trunc(epochMilliseconds)) + FILETIME_EPOCH_OFFSET_MS) * FILETIME_PER_MS,
  );
  return time;
}

export interface BlobRequest {
  readonly timestamp: Buffer;
  readonly clientChallenge: Buffer;
  readonly attributes: Buffer;
}

export function ntlmv2Blob(request: BlobRequest): Buffer {
  return Buffer.concat([
    BLOB_HEADER,
    request.timestamp,
    request.clientChallenge,
    Buffer.alloc(RESERVED_BYTES),
    request.attributes,
    Buffer.alloc(RESERVED_BYTES),
  ]);
}

/**
 * The two challenge responses and the session base key everything else is
 * derived from. `NTProofStr` is the HMAC the server recomputes; the response
 * carries the blob after it so the server can.
 */
export function ntlmv2Response(request: Ntlmv2Request): Ntlmv2Response {
  const proof = hmacMd5(request.key, Buffer.concat([request.serverChallenge, request.blob]));
  return {
    nt: Buffer.concat([proof, request.blob]),
    lm: request.isTimestamped
      ? Buffer.alloc(LM_RESPONSE_BYTES)
      : Buffer.concat([
          hmacMd5(request.key, Buffer.concat([request.serverChallenge, request.clientChallenge])),
          request.clientChallenge,
        ]),
    sessionBaseKey: hmacMd5(request.key, proof),
  };
}
