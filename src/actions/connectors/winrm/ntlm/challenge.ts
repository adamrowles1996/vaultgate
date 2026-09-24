/**
 * The `CHALLENGE_MESSAGE` (MS-NLMP 2.2.1.2) and the attribute list it carries.
 * Everything in this file is attacker-reachable input from a destination that
 * has proved nothing yet (T33), so it is read through `./reader.ts`: the
 * signature and message type are checked before anything else, every offset
 * and length is bounds-checked, the attribute list is capped, and a message
 * that is not exactly the shape the protocol promises is refused rather than
 * worked around.
 */
import { MESSAGE_CHALLENGE, NTLM_SIGNATURE, REQUIRED_FLAGS } from './flags.ts';
import { Bytes, NtlmProblem } from './reader.ts';

const SIGNATURE_BYTES = 8;
const TYPE_AT = 8;
const FLAGS_AT = 20;
const SERVER_CHALLENGE_AT = 24;
const SERVER_CHALLENGE_BYTES = 8;
const TARGET_INFO_AT = 40;

/**
 * No Windows target list comes close; the cap stops a hostile destination
 * making the reader walk a list it never has to finish.
 */
const MAX_ATTRIBUTES = 64;

const ATTRIBUTE_HEADER_BYTES = 4;
const FLAGS_VALUE_BYTES = 4;
const TIMESTAMP_BYTES = 8;

export const AV_EOL = 0x00_00;
export const AV_FLAGS = 0x00_06;
export const AV_TIMESTAMP = 0x00_07;
/**
RFC 5929: the client adds this one; it binds the exchange to the TLS connection it travelled.
*/
export const AV_CHANNEL_BINDINGS = 0x00_0a;

/**
MS-NLMP 2.2.2.1: the client sets this in `MsvAvFlags` to say the third message carries a MIC.
*/
export const AV_FLAG_MIC_PROVIDED = 0x00_00_00_02;

export interface AvPair {
  readonly id: number;
  readonly value: Buffer;
}

export interface Challenge {
  readonly flags: number;
  readonly serverChallenge: Buffer;
  readonly attributes: readonly AvPair[];
  /**
  MS-NLMP 3.1.5.1.2: its presence is what asks the client for a MIC and fixes the blob's timestamp.
  */
  readonly timestamp: Buffer | undefined;
  /**
  The message as it arrived; the MIC is taken over all three messages, byte for byte.
  */
  readonly raw: Buffer;
}

/**
The attribute list, ending at its terminator; anything after it is not read and not re-sent.
*/
export function readAttributes(info: Buffer): readonly AvPair[] {
  const bytes = new Bytes(info);
  const pairs: AvPair[] = [];
  let at = 0;
  for (let count = 0; count <= MAX_ATTRIBUTES; count += 1) {
    const id = bytes.u16(at, 'an attribute identifier');
    const length = bytes.u16(at + 2, 'an attribute length');
    const value = bytes.slice(at + ATTRIBUTE_HEADER_BYTES, length, 'an attribute value');
    at += ATTRIBUTE_HEADER_BYTES + length;
    if (id === AV_EOL) {
      if (length !== 0) {
        throw new NtlmProblem('the terminating attribute carries a value');
      }
      return pairs;
    }
    pairs.push({ id, value });
  }
  throw new NtlmProblem('the target information holds more attributes than any challenge does');
}

function timestampOf(pairs: readonly AvPair[]): Buffer | undefined {
  const found = pairs.find((pair) => pair.id === AV_TIMESTAMP);
  if (found === undefined) {
    return undefined;
  }
  if (found.value.length !== TIMESTAMP_BYTES) {
    throw new NtlmProblem('the timestamp attribute is not eight bytes');
  }
  return found.value;
}

/**
 * The challenge, or an `NtlmProblem`. The flags are checked here as well as
 * the shape: a destination that will not agree to Unicode, extended session
 * security, sealing, signing and 128-bit keys cannot give this connector the
 * exchange it promises the operator, and meeting it half-way would be a
 * silent downgrade (ACT-89).
 */
export function parseChallenge(raw: Buffer): Challenge {
  const bytes = new Bytes(raw);
  if (!bytes.slice(0, SIGNATURE_BYTES, 'the signature').equals(NTLM_SIGNATURE)) {
    throw new NtlmProblem('it does not begin with the NTLMSSP signature');
  }
  if (bytes.u32(TYPE_AT, 'the message type') !== MESSAGE_CHALLENGE) {
    throw new NtlmProblem('it is not a challenge');
  }
  const flags = bytes.u32(FLAGS_AT, 'the negotiated flags');
  const attributes = readAttributes(bytes.field(TARGET_INFO_AT, 'the target information'));
  refuseWeakFlags(flags);
  return {
    flags,
    serverChallenge: bytes.slice(
      SERVER_CHALLENGE_AT,
      SERVER_CHALLENGE_BYTES,
      'the server challenge',
    ),
    attributes,
    timestamp: timestampOf(attributes),
    raw,
  };
}

function refuseWeakFlags(flags: number): void {
  if ((flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS) {
    throw new NtlmProblem(
      'it offers neither Unicode, extended session security, sealing, signing nor 128-bit keys',
    );
  }
}

function attributeBytes(pair: AvPair): Buffer {
  const header = Buffer.alloc(ATTRIBUTE_HEADER_BYTES);
  header.writeUInt16LE(pair.id, 0);
  header.writeUInt16LE(pair.value.length, 2);
  return Buffer.concat([header, pair.value]);
}

/**
The attribute list as bytes, terminated; the inverse of `readAttributes`.
*/
export function writeAttributes(pairs: readonly AvPair[]): Buffer {
  return Buffer.concat([
    ...pairs.map((pair) => attributeBytes(pair)),
    Buffer.alloc(ATTRIBUTE_HEADER_BYTES),
  ]);
}

/**
 * MS-NLMP 3.1.5.1.2: when the server timestamped its challenge the client
 * announces its MIC by setting bit 1 of `MsvAvFlags`, adding the attribute if
 * the server sent none. Every other attribute is returned untouched and in
 * order, because the server checks the list it gets back against the one it
 * sent.
 */
export function withMicAnnounced(pairs: readonly AvPair[]): readonly AvPair[] {
  const existing = pairs.find((pair) => pair.id === AV_FLAGS);
  if (existing !== undefined && existing.value.length !== FLAGS_VALUE_BYTES) {
    throw new NtlmProblem('the flags attribute is not four bytes');
  }
  const value = Buffer.alloc(FLAGS_VALUE_BYTES);
  const announced =
    (existing === undefined ? 0 : existing.value.readUInt32LE(0)) | AV_FLAG_MIC_PROVIDED;
  value.writeUInt32LE(announced >>> 0, 0);
  const announcedPair: AvPair = { id: AV_FLAGS, value };
  return existing === undefined
    ? [...pairs, announcedPair]
    : pairs.map((pair) => (pair.id === AV_FLAGS ? announcedPair : pair));
}

/**
 * The attribute list the client puts in the blob: the server's, with the MIC
 * announced where one is due and the channel binding appended where there is
 * a channel to bind to. Both are attributes MS-NLMP expects a client to add
 * to the list it echoes; a plain `http://` connection has no channel, so the
 * pair is omitted rather than sent empty.
 */
export function blobAttributes(challenge: Challenge, channelBinding: Buffer | undefined): Buffer {
  const announced =
    challenge.timestamp === undefined
      ? challenge.attributes
      : withMicAnnounced(challenge.attributes);
  return writeAttributes(
    channelBinding === undefined
      ? announced
      : [...announced, { id: AV_CHANNEL_BINDINGS, value: channelBinding }],
  );
}
