import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { channelBindingToken, endPointDigest } from './channel-binding.ts';

const SHA256_WITH_RSA = '2a864886f70d01010b';
const SHA384_WITH_RSA = '2a864886f70d01010c';
const SHA512_WITH_RSA = '2a864886f70d01010d';
const ECDSA_WITH_SHA256 = '2a8648ce3d040302';
const ECDSA_WITH_SHA384 = '2a8648ce3d040303';
const ECDSA_WITH_SHA512 = '2a8648ce3d040304';
const SHA1_WITH_RSA = '2a864886f70d010105';
const ED25519 = '2b6570';

const SEQUENCE = 0x30;
const OBJECT_IDENTIFIER = 0x06;
const BIT_STRING = 0x03;
const INTEGER = 0x02;

/**
 * One DER element, in the long form when its value needs it — which every
 * real `tbsCertificate` does, so the reader's long-form path is the one these
 * fixtures exercise.
 */
function der(tag: number, value: Buffer): Buffer {
  if (value.length < 0x80) {
    return Buffer.concat([Buffer.from([tag, value.length]), value]);
  }
  const length = Buffer.alloc(2);
  length.writeUInt16BE(value.length);
  return Buffer.concat([Buffer.from([tag, 0x82]), length, value]);
}

/**
A `tbsCertificate` long enough to need a long-form length, as every real one is, and a signature.
*/
const TBS_CERTIFICATE = der(SEQUENCE, Buffer.alloc(200));
const SIGNATURE_VALUE = der(BIT_STRING, Buffer.alloc(8));

function algorithmIdentifier(identifier: string, tag: number): Buffer {
  return der(tag, der(OBJECT_IDENTIFIER, Buffer.from(identifier, 'hex')));
}

/**
 * `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }`
 * with only the parts the reader walks filled in; nothing here reads the body
 * of the certificate itself.
 */
function certificate(identifier: string, algorithm = SEQUENCE): Buffer {
  const members = [TBS_CERTIFICATE, algorithmIdentifier(identifier, algorithm), SIGNATURE_VALUE];
  return der(SEQUENCE, Buffer.concat(members));
}

/**
An `AlgorithmIdentifier` whose first member is an integer rather than an object identifier.
*/
const NO_IDENTIFIER = der(SEQUENCE, der(INTEGER, Buffer.alloc(2)));

describe('endPointDigest', () => {
  it('ACT-89 takes SHA-384 and SHA-512 from the certificate that was signed with one', () => {
    expect(endPointDigest(certificate(SHA384_WITH_RSA))).toBe('sha384');
    expect(endPointDigest(certificate(ECDSA_WITH_SHA384))).toBe('sha384');
    expect(endPointDigest(certificate(SHA512_WITH_RSA))).toBe('sha512');
    expect(endPointDigest(certificate(ECDSA_WITH_SHA512))).toBe('sha512');
  });

  it('ACT-89 binds a SHA-256 certificate with SHA-256', () => {
    expect(endPointDigest(certificate(SHA256_WITH_RSA))).toBe('sha256');
    expect(endPointDigest(certificate(ECDSA_WITH_SHA256))).toBe('sha256');
  });

  it('ACT-89 raises a SHA-1 certificate to SHA-256, as RFC 5929 requires', () => {
    expect(endPointDigest(certificate(SHA1_WITH_RSA))).toBe('sha256');
  });

  it('ACT-89 binds a signature algorithm that names no digest with SHA-256', () => {
    expect(endPointDigest(certificate(ED25519))).toBe('sha256');
  });

  it('T33 falls back to SHA-256 for bytes that are not a readable certificate', () => {
    const unreadable = [
      // Nothing at all, and a tag with no length byte.
      Buffer.alloc(0),
      Buffer.from([SEQUENCE]),
      // An outer element that is not a SEQUENCE.
      der(INTEGER, Buffer.alloc(8)),
      // A length that runs past the end, in the short form and the long form.
      Buffer.from([SEQUENCE, 0x7f]),
      Buffer.from([SEQUENCE, 0x82, 0x01, 0x00, 0x00]),
      // A long form that declares no length bytes, or more than any length needs.
      Buffer.from([SEQUENCE, 0x80]),
      Buffer.from([SEQUENCE, 0x85, 0, 0, 0, 0, 0]),
      // A long form whose own length bytes are cut off.
      Buffer.from([SEQUENCE, 0x84, 0, 0]),
      // An outer SEQUENCE whose tbsCertificate is truncated.
      der(SEQUENCE, Buffer.from([SEQUENCE])),
      // A signatureAlgorithm that is not a SEQUENCE, and one holding no identifier.
      certificate(SHA384_WITH_RSA, INTEGER),
      der(SEQUENCE, Buffer.concat([TBS_CERTIFICATE, NO_IDENTIFIER])),
    ];
    for (const bytes of unreadable) {
      expect(endPointDigest(bytes)).toBe('sha256');
    }
  });

  it('ACT-89 reads a signature algorithm behind a four-byte length', () => {
    const wide = Buffer.concat([
      Buffer.from([SEQUENCE, 0x84, 0, 0, 0, 0]),
      TBS_CERTIFICATE,
      algorithmIdentifier(SHA512_WITH_RSA, SEQUENCE),
    ]);
    wide.writeUInt32BE(wide.length - 6, 2);
    expect(endPointDigest(wide)).toBe('sha512');
  });
});

describe('channelBindingToken', () => {
  it('ACT-89 is the MD5 of the gss_channel_bindings_struct over tls-server-end-point', () => {
    const leaf = certificate(SHA256_WITH_RSA);
    // Four empty address words, then the length of the application data —
    // twenty-one bytes of prefix and a thirty-two byte digest, so 0x35.
    const marshalled = Buffer.concat([
      Buffer.from('0000000000000000000000000000000035000000', 'hex'),
      Buffer.from('tls-server-end-point:', 'ascii'),
      createHash('sha256').update(leaf).digest(),
    ]);
    expect(channelBindingToken(leaf)).toStrictEqual(createHash('md5').update(marshalled).digest());
    expect(channelBindingToken(leaf)).toHaveLength(16);
  });

  it('ACT-89 is a different token for a different certificate, which is the whole point', () => {
    const other = channelBindingToken(certificate(SHA384_WITH_RSA));
    expect(channelBindingToken(certificate(SHA256_WITH_RSA))).not.toStrictEqual(other);
  });
});
