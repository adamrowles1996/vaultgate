import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hostKeyBlob, HOST_KEYS } from '../../../test-support/fake-ssh-client.ts';

import { hostKeyProblem, isPinnedHostKey, parseHostKey } from './host-key.ts';

const PINNED = hostKeyBlob(HOST_KEYS.pinned);
const OTHER = hostKeyBlob(HOST_KEYS.other);

describe('parseHostKey', () => {
  it('ACT-87 reads the key out of a ssh-keyscan line, a .pub line and a bare type and key pair', () => {
    const blob = { kind: 'key', blob: PINNED };
    expect(parseHostKey(`build.example.com ${HOST_KEYS.pinned}`)).toStrictEqual(blob);
    expect(parseHostKey(HOST_KEYS.pinned)).toStrictEqual(blob);
    expect(parseHostKey(`  ${HOST_KEYS.pinned.split(' ').slice(0, 2).join(' ')}  `)).toStrictEqual(
      blob,
    );
  });

  it('ACT-87 reads a SHA256 fingerprint with or without its padding', () => {
    expect(parseHostKey(HOST_KEYS.fingerprint)).toStrictEqual({
      kind: 'fingerprint',
      digest: HOST_KEYS.fingerprint.slice('SHA256:'.length),
    });
    expect(parseHostKey(`${HOST_KEYS.fingerprint}=`)).toStrictEqual({
      kind: 'fingerprint',
      digest: HOST_KEYS.fingerprint.slice('SHA256:'.length),
    });
  });

  it('ACT-87 refuses a fingerprint that is not base64 and an empty one', () => {
    expect(parseHostKey('SHA256:not base64!')).toBeUndefined();
    expect(parseHostKey('SHA256:')).toBeUndefined();
  });

  it('ACT-87 refuses a key type it does not know, base64 that is not one, and a blob of another type', () => {
    expect(parseHostKey(`ssh-magic ${PINNED.toString('base64')}`)).toBeUndefined();
    expect(parseHostKey('ssh-ed25519 not-base64!!')).toBeUndefined();
    expect(parseHostKey(`ssh-rsa ${PINNED.toString('base64')}`)).toBeUndefined();
  });

  it('ACT-87 refuses a key line with nothing after the type and one with no key at all', () => {
    expect(parseHostKey('ssh-ed25519')).toBeUndefined();
    expect(parseHostKey('build.example.com')).toBeUndefined();
  });

  it('ACT-87 refuses base64 too short to carry a type and one whose type length is impossible', () => {
    expect(parseHostKey(`ssh-ed25519 ${Buffer.from([1, 2]).toString('base64')}`)).toBeUndefined();
    const huge = Buffer.alloc(8);
    huge.writeUInt32BE(1000, 0);
    expect(parseHostKey(`ssh-ed25519 ${huge.toString('base64')}`)).toBeUndefined();
    const empty = Buffer.alloc(8);
    expect(parseHostKey(`ssh-ed25519 ${empty.toString('base64')}`)).toBeUndefined();
  });
});

describe('hostKeyProblem', () => {
  it('ACT-87 accepts both forms and explains the one thing wrong with anything else', () => {
    expect(hostKeyProblem(HOST_KEYS.pinned)).toBeUndefined();
    expect(hostKeyProblem(HOST_KEYS.fingerprint)).toBeUndefined();
    expect(hostKeyProblem('trust me')).toBe(
      'must be a public key line as ssh-keyscan prints it, or a SHA256: fingerprint',
    );
  });
});

describe('isPinnedHostKey', () => {
  it('ACT-87 matches the pinned key by its bytes and refuses any other key', () => {
    expect(isPinnedHostKey(HOST_KEYS.pinned, PINNED)).toBe(true);
    expect(isPinnedHostKey(HOST_KEYS.pinned, OTHER)).toBe(false);
  });

  it('ACT-87 matches the pinned key by its fingerprint and refuses any other key', () => {
    expect(isPinnedHostKey(HOST_KEYS.fingerprint, PINNED)).toBe(true);
    expect(isPinnedHostKey(HOST_KEYS.fingerprint, OTHER)).toBe(false);
    expect(HOST_KEYS.fingerprint).toBe(
      `SHA256:${createHash('sha256').update(PINNED).digest('base64').replaceAll('=', '')}`,
    );
  });

  it('ACT-87 refuses every key when the pin itself does not parse, so nothing falls open', () => {
    expect(isPinnedHostKey('trust me', PINNED)).toBe(false);
  });
});
