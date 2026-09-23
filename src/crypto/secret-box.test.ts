import { describe, expect, it } from 'vitest';

import { fixedRandom, sequentialRandom } from '../test-support/identity.ts';

import {
  createSecretBox,
  STATE_COOKIE_INFO,
  TOTP_SECRET_INFO,
  VAULT_CLIENT_SECRET_INFO,
  VAULT_MASTER_PASSWORD_INFO,
} from './secret-box.ts';

const ROOT_KEY = Buffer.alloc(32, 9);

describe('createSecretBox', () => {
  it('ID-9 seals as v1.<iv>.<ciphertext>.<tag> in base64url and opens it again', () => {
    const box = createSecretBox(ROOT_KEY, TOTP_SECRET_INFO, fixedRandom(4));
    const sealed = box.seal(Buffer.from('twenty-byte-secret!!'));
    const [version, iv, ciphertext, tag] = sealed.split('.', 4);
    const ciphertextBytes = Buffer.from(ciphertext ?? '', 'base64url');
    const tagBytes = Buffer.from(tag ?? '', 'base64url');
    expect(version).toBe('v1');
    expect(iv).toBe(Buffer.alloc(12, 4).toString('base64url'));
    expect(ciphertextBytes.length).toBe(20);
    expect(tagBytes.length).toBe(16);
    expect(box.open(sealed)?.toString()).toBe('twenty-byte-secret!!');
  });

  it('ID-9 uses a fresh IV for every seal', () => {
    const box = createSecretBox(ROOT_KEY, TOTP_SECRET_INFO, sequentialRandom());
    const first = box.seal(Buffer.from('x'));
    const second = box.seal(Buffer.from('x'));
    expect(first).not.toBe(second);
  });

  it('ID-9 STORE-9 separates purposes through the HKDF info', () => {
    const infos = [
      TOTP_SECRET_INFO,
      STATE_COOKIE_INFO,
      VAULT_CLIENT_SECRET_INFO,
      VAULT_MASTER_PASSWORD_INFO,
    ];
    expect(new Set(infos).size).toBe(infos.length);
    const boxes = infos.map((info) => createSecretBox(ROOT_KEY, info, fixedRandom()));
    const sealed = boxes[0]!.seal(Buffer.from('x'));
    expect(boxes.slice(1).map((box) => box.open(sealed))).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('ID-9 refuses tampered, truncated or foreign input', () => {
    const box = createSecretBox(ROOT_KEY, TOTP_SECRET_INFO, fixedRandom());
    const sealed = box.seal(Buffer.from('payload'));
    const [version, iv, ciphertext, tag] = sealed.split('.', 4) as [string, string, string, string];
    expect(box.open(`${version}.${iv}.${ciphertext}.${tag.slice(0, -2)}AA`)).toBeUndefined();
    expect(box.open(`v2.${iv}.${ciphertext}.${tag}`)).toBeUndefined();
    expect(box.open(`${version}.${iv}.${ciphertext}`)).toBeUndefined();
    expect(box.open(`${version}.AAAA.${ciphertext}.${tag}`)).toBeUndefined();
    expect(box.open(`${version}.${iv}.${ciphertext}.AAAA`)).toBeUndefined();
  });
});
