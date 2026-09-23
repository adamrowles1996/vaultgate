import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

/**
Bytes from an injected entropy source; production wires `randomBytes`.
*/
export type RandomSource = (bytes: number) => Buffer;

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PART_COUNT = 4;

export interface SecretBox {
  /**
  `v1.<iv>.<ciphertext>.<tag>`, each part base64url.
  */
  seal(plaintext: Buffer): string;
  /**
  The plaintext, or `undefined` for anything that does not authenticate.
  */
  open(sealed: string): Buffer | undefined;
}

/**
 * HKDF-SHA256 from the root secret. `info` separates purposes: TOTP secrets,
 * browser state cookies, the stored vault credentials and the actions
 * confirmation HMAC never share a key even though they share the root. Every
 * purpose is catalogued below.
 */
export function deriveKey(rootKey: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', rootKey, Buffer.alloc(0), info, KEY_BYTES));
}

/**
 * AES-256-GCM under a key derived from the root secret (ID-9, STORE-9).
 */
export function createSecretBox(rootKey: Buffer, info: string, random: RandomSource): SecretBox {
  const key = deriveKey(rootKey, info);
  return {
    seal(plaintext) {
      const iv = random(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const parts = [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString('base64url'));
      return [VERSION, ...parts].join('.');
    },
    open(sealed) {
      const parts = sealed.split('.');
      if (parts.length !== PART_COUNT || parts[0] !== VERSION) {
        return;
      }
      const [iv, ciphertext, tag] = parts.slice(1).map((part) => Buffer.from(part, 'base64url'));
      if (ciphertext === undefined || iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES) {
        return;
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        return;
      }
    },
  };
}

export const TOTP_SECRET_INFO = 'vaultgate/totp-secret/v1';
export const STATE_COOKIE_INFO = 'vaultgate/state-cookie/v1';
export const VAULT_CLIENT_SECRET_INFO = 'vaultgate/vault-client-secret/v1';
export const VAULT_MASTER_PASSWORD_INFO = 'vaultgate/vault-master-password/v1';
export const ACTIONS_CONFIRMATION_INFO = 'vaultgate/actions-confirmation/v1';
