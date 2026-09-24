/**
 * The channel-binding token an NTLM exchange over TLS carries, so that the
 * handshake is bound to the connection it travelled and cannot be relayed on
 * to a different one (MS-NLMP 2.2.2.1 `MsvAvChannelBindings`, RFC 5929).
 *
 * Without it an attacker who can terminate TLS in front of the destination
 * relays the three messages and authenticates as the operator's account
 * somewhere else: nothing in the exchange names the channel. Windows exposes
 * the server's half of this as `CbtHardeningLevel`, whose default `Relaxed`
 * accepts a client that sends no token and verifies one that is sent — so
 * sending it is the client's job, it costs one hash, and it makes the relay
 * fail on a host that is already configured to check.
 *
 * `tls-server-end-point` binds to the server's leaf certificate. RFC 5929 4.1
 * takes the digest from the certificate's own signature algorithm, with MD5
 * and SHA-1 raised to SHA-256; vaultgate reads that algorithm out of the DER
 * and uses SHA-384 or SHA-512 where the certificate is signed with one, and
 * SHA-256 for everything else, which is the same choice Windows makes.
 *
 * The final MD5 is the protocol's, not a choice: MS-NLMP defines the AV pair
 * as the MD5 of the `gss_channel_bindings_struct`, so a client that digests
 * anything else sends a token no server can verify. CodeQL reports it as a
 * weak algorithm and is right about MD5; what the token protects against is a
 * relay, and an attacker who could forge a collision here would still have to
 * make the forged struct hold the certificate of a connection it does not
 * hold. See the header of `../../../../crypto/md4.ts` and ACT-89.
 */
import { createHash } from 'node:crypto';

const SEQUENCE = 0x30;
const OBJECT_IDENTIFIER = 0x06;
const LONG_FORM = 0x80;
const LENGTH_COUNT = 0x7f;
const MAX_LENGTH_BYTES = 4;
const BYTE_VALUES = 256;

interface Element {
  readonly tag: number;
  /**
  Where the value begins, and where it ends — which is where the next element begins.
  */
  readonly from: number;
  readonly to: number;
}

/**
 * The tag-length-value at `at`, or `undefined` when the bytes do not hold a
 * complete one. Every length is checked against the buffer before it is
 * believed: the certificate came off a socket, so nothing here trusts it.
 */
function elementAt(der: Buffer, at: number): Element | undefined {
  if (at + 2 > der.length) {
    return undefined;
  }
  const tag = der.readUInt8(at);
  const marker = der.readUInt8(at + 1);
  if (marker < LONG_FORM) {
    return bounded(der, tag, at + 2, marker);
  }
  const count = marker & LENGTH_COUNT;
  if (count === 0 || count > MAX_LENGTH_BYTES || at + 2 + count > der.length) {
    return undefined;
  }
  let length = 0;
  for (let step = 0; step < count; step += 1) {
    length = length * BYTE_VALUES + der.readUInt8(at + 2 + step);
  }
  return bounded(der, tag, at + 2 + count, length);
}

function bounded(der: Buffer, tag: number, from: number, length: number): Element | undefined {
  const to = from + length;
  return to > der.length ? undefined : { tag, from, to };
}

function taggedAt(der: Buffer, at: number, tag: number): Element | undefined {
  const element = elementAt(der, at);
  return element?.tag === tag ? element : undefined;
}

/**
 * `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }`
 * (RFC 5280 4.1): the second member is an `AlgorithmIdentifier` whose first
 * member is the object identifier this reads. `undefined` for anything that
 * is not that shape, which the caller answers with the default digest rather
 * than a failed call.
 */
function signatureAlgorithm(certificate: Buffer): Buffer | undefined {
  const outer = taggedAt(certificate, 0, SEQUENCE);
  const tbsCertificate = outer === undefined ? undefined : elementAt(certificate, outer.from);
  const algorithm =
    tbsCertificate === undefined ? undefined : taggedAt(certificate, tbsCertificate.to, SEQUENCE);
  const identifier =
    algorithm === undefined ? undefined : taggedAt(certificate, algorithm.from, OBJECT_IDENTIFIER);
  return identifier === undefined
    ? undefined
    : certificate.subarray(identifier.from, identifier.to);
}

/**
 * The two digests that are not the default, by signature-algorithm identifier:
 * `sha384WithRSAEncryption` and `ecdsa-with-SHA384`, then their SHA-512 pair.
 */
const DIGESTS: ReadonlyMap<string, string> = new Map([
  ['2a864886f70d01010c', 'sha384'],
  ['2a8648ce3d040303', 'sha384'],
  ['2a864886f70d01010d', 'sha512'],
  ['2a8648ce3d040304', 'sha512'],
]);

const DEFAULT_DIGEST = 'sha256';

/**
 * RFC 5929 4.1. SHA-1 and MD5 are raised to SHA-256 by the specification
 * itself; an algorithm that names no single digest — RSASSA-PSS, which hides
 * one in its parameters, or Ed25519, which has none — is bound with SHA-256
 * too, which is what leaves the token interoperable. Guessing wrong costs a
 * refused handshake on a destination that checks, never a weaker one.
 */
export function endPointDigest(certificate: Buffer): string {
  const identifier = signatureAlgorithm(certificate);
  return (
    (identifier === undefined ? undefined : DIGESTS.get(identifier.toString('hex'))) ??
    DEFAULT_DIGEST
  );
}

const APPLICATION_DATA_PREFIX = 'tls-server-end-point:';

const WORD_BYTES = 4;
/**
 * `initiator_addrtype`, `initiator_address.length`, `acceptor_addrtype` and
 * `acceptor_address.length`, all zero: neither end names an address, so only
 * the application data is bound.
 */
const ADDRESS_WORDS = 4;

/**
 * The `gss_channel_bindings_struct` as SSPI marshals it — the four empty
 * address words, the length of the application data, then the data itself,
 * every word little-endian.
 */
function channelBindings(endPointData: Buffer): Buffer {
  const head = Buffer.alloc((ADDRESS_WORDS + 1) * WORD_BYTES);
  head.writeUInt32LE(endPointData.length, ADDRESS_WORDS * WORD_BYTES);
  return Buffer.concat([head, endPointData]);
}

/**
 * The sixteen bytes of `MsvAvChannelBindings` for a connection whose peer
 * presented `certificate`. A plain `http://` destination has no channel to
 * bind to and sends no such pair at all; the caller decides that, because
 * this function has no way to tell.
 */
export function channelBindingToken(certificate: Buffer): Buffer {
  const endPointData = Buffer.concat([
    Buffer.from(APPLICATION_DATA_PREFIX, 'ascii'),
    createHash(endPointDigest(certificate)).update(certificate).digest(),
  ]);
  return createHash('md5').update(channelBindings(endPointData)).digest();
}
