/**
 * The `AUTHENTICATE_MESSAGE` (MS-NLMP 2.2.1.3): the third and last NTLM
 * message, carrying the NTLMv2 responses, the account it is for, the session
 * key sealed to the server, and — when the server timestamped its challenge —
 * a MIC over all three messages, which is what stops the exchange being
 * spliced with a different negotiate or challenge.
 *
 * The version and MIC fields are always written, so the payload always starts
 * at the same offset: a receiver looks for the MIC at offset 72 whatever the
 * flags say, and leaving the space out would move every field that follows.
 */
import { rc4 } from '../../../../crypto/rc4.ts';

import { blobAttributes, type Challenge } from './challenge.ts';
import { FLAG, MESSAGE_AUTHENTICATE, NEGOTIATE_FLAGS, NTLM_SIGNATURE, VERSION } from './flags.ts';
import {
  fileTime,
  hmacMd5,
  ntlmv2Blob,
  ntlmv2Response,
  ntowfv2,
  type NtlmCredential,
} from './ntlmv2.ts';

const TYPE_AT = 8;
const FIELD_AT = {
  lm: 12,
  nt: 20,
  domain: 28,
  user: 36,
  workstation: 44,
  sessionKey: 52,
} as const;
const LENGTH_AT = 2;
const OFFSET_AT = 4;
const FLAGS_AT = 60;
const VERSION_AT = 64;
const MIC_AT = 72;
const MIC_BYTES = 16;
const HEADER_BYTES = 88;

const CLIENT_CHALLENGE_BYTES = 8;
const SESSION_KEY_BYTES = 16;

const ORDER = ['lm', 'nt', 'domain', 'user', 'workstation', 'sessionKey'] as const;

type Parts = Readonly<Record<(typeof ORDER)[number], Buffer>>;

export interface AuthenticateRequest {
  readonly credential: NtlmCredential;
  readonly challenge: Challenge;
  /**
  The Type 1 message as it was sent; the MIC covers all three, byte for byte.
  */
  readonly negotiate: Buffer;
  /**
  RFC 5929: `MsvAvChannelBindings` for a TLS connection, `undefined` for a plain one.
  */
  readonly channelBinding: Buffer | undefined;
  readonly random: (bytes: number) => Buffer;
  readonly now: () => number;
}

export interface Authentication {
  readonly message: Buffer;
  /**
  What the signing and sealing keys of `./security.ts` are derived from; never logged, never returned.
  */
  readonly exportedSessionKey: Buffer;
  readonly isKeyExchange: boolean;
}

function assemble(parts: Parts, flags: number): Buffer {
  const payload = Buffer.concat(ORDER.map((name) => parts[name]));
  const message = Buffer.alloc(HEADER_BYTES + payload.length);
  NTLM_SIGNATURE.copy(message);
  message.writeUInt32LE(MESSAGE_AUTHENTICATE, TYPE_AT);
  let offset = HEADER_BYTES;
  for (const name of ORDER) {
    const value = parts[name];
    message.writeUInt16LE(value.length, FIELD_AT[name]);
    message.writeUInt16LE(value.length, FIELD_AT[name] + LENGTH_AT);
    message.writeUInt32LE(offset, FIELD_AT[name] + OFFSET_AT);
    offset += value.length;
  }
  message.writeUInt32LE(flags >>> 0, FLAGS_AT);
  VERSION.copy(message, VERSION_AT);
  payload.copy(message, HEADER_BYTES);
  return message;
}

/**
 * MS-NLMP 3.1.5.1.2: the MIC is an HMAC over the three messages with the MIC
 * field still zeroed, written back into the message it covers.
 */
function signIntegrity(
  message: Buffer,
  negotiate: Buffer,
  challenge: Challenge,
  key: Buffer,
): void {
  const mic = hmacMd5(key, Buffer.concat([negotiate, challenge.raw, message]));
  mic.subarray(0, MIC_BYTES).copy(message, MIC_AT);
}

export function authenticateMessage(request: AuthenticateRequest): Authentication {
  const { challenge, credential } = request;
  const negotiated = (NEGOTIATE_FLAGS & challenge.flags) >>> 0;
  const clientChallenge = request.random(CLIENT_CHALLENGE_BYTES);
  const blob = ntlmv2Blob({
    timestamp: challenge.timestamp ?? fileTime(request.now()),
    clientChallenge,
    attributes: blobAttributes(challenge, request.channelBinding),
  });
  const response = ntlmv2Response({
    key: ntowfv2(credential),
    serverChallenge: challenge.serverChallenge,
    clientChallenge,
    blob,
    isTimestamped: challenge.timestamp !== undefined,
  });
  const isKeyExchange = (negotiated & FLAG.keyExchange) !== 0;
  const exportedSessionKey = isKeyExchange
    ? request.random(SESSION_KEY_BYTES)
    : response.sessionBaseKey;
  const message = assemble(
    {
      lm: response.lm,
      nt: response.nt,
      domain: Buffer.from(credential.domain, 'utf16le'),
      user: Buffer.from(credential.username, 'utf16le'),
      workstation: Buffer.alloc(0),
      sessionKey: isKeyExchange
        ? rc4(response.sessionBaseKey, exportedSessionKey)
        : Buffer.alloc(0),
    },
    negotiated,
  );
  if (challenge.timestamp !== undefined) {
    signIntegrity(message, request.negotiate, challenge, exportedSessionKey);
  }
  return { message, exportedSessionKey, isKeyExchange };
}
