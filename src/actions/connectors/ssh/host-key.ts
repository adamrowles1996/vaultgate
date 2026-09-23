/**
 * The pinned host key of an `ssh` target (ACT-87): the operator gives the
 * public key line `ssh-keyscan` prints, or its `SHA256:` fingerprint, and the
 * key the server presents during the handshake must equal it. There is no
 * trust-on-first-use and no way to skip the check, so the same parser runs at
 * save (the destination schema) and at connect (the client's `hostVerifier`),
 * and a key that does not parse can never be saved.
 */
import { createHash } from 'node:crypto';

const FINGERPRINT_PREFIX = 'SHA256:';

/**
 * The key types OpenSSH writes in a `known_hosts` or `.pub` line. `ssh-rsa`
 * names the key format, which a server may still present while signing with
 * `rsa-sha2-256`/`rsa-sha2-512`; the SHA-1 signature algorithm of the same
 * name is what the client refuses (`serverHostKey` in `client.ts`).
 */
const KEY_TYPE =
  /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/u;

const MAX_TYPE_BYTES = 64;
const LENGTH_BYTES = 4;

export type PinnedHostKey =
  | { readonly kind: 'fingerprint'; readonly digest: string }
  | { readonly kind: 'key'; readonly blob: Buffer };

function base64(blob: Buffer): string {
  return blob.toString('base64').replaceAll('=', '');
}

/**
The algorithm name an SSH public key blob starts with, or `undefined` when the bytes are not one.
*/
function blobType(blob: Buffer): string | undefined {
  if (blob.length < LENGTH_BYTES) {
    return undefined;
  }
  const length = blob.readUInt32BE(0);
  return length > 0 && length <= MAX_TYPE_BYTES && blob.length >= LENGTH_BYTES + length
    ? blob.subarray(LENGTH_BYTES, LENGTH_BYTES + length).toString('ascii')
    : undefined;
}

/**
The key a `<type> <base64>` pair names, when the base64 decodes to a key blob of that very type.
*/
function keyOf(type: string, encoded: string): PinnedHostKey | undefined {
  if (!KEY_TYPE.test(type)) {
    return undefined;
  }
  const blob = Buffer.from(encoded, 'base64');
  return base64(blob) === encoded.replaceAll('=', '') && blobType(blob) === type
    ? { kind: 'key', blob }
    : undefined;
}

function fingerprintOf(text: string): PinnedHostKey | undefined {
  const digest = text.slice(FINGERPRINT_PREFIX.length).replaceAll('=', '');
  return base64(Buffer.from(digest, 'base64')) === digest && digest.length > 0
    ? { kind: 'fingerprint', digest }
    : undefined;
}

/**
 * The pinned key as either form: `SHA256:<base64>`, or a key line with an
 * optional host prefix and an optional comment (`ssh-keyscan` writes the
 * host, `.pub` files write the comment). `undefined` when neither parses.
 */
export function parseHostKey(text: string): PinnedHostKey | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith(FINGERPRINT_PREFIX)) {
    return fingerprintOf(trimmed);
  }
  const tokens = trimmed.split(/\s+/u);
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const key = next === undefined ? undefined : keyOf(token, next);
    if (key !== undefined) {
      return key;
    }
  }
  return undefined;
}

/**
ACT-87: what the operator sees when `host_key` is neither form, at save rather than at call time.
*/
export function hostKeyProblem(text: string): string | undefined {
  return parseHostKey(text) === undefined
    ? 'must be a public key line as ssh-keyscan prints it, or a SHA256: fingerprint'
    : undefined;
}

/**
ACT-87: whether the key the server presented is the pinned one; the handshake stops here if not.
*/
export function isPinnedHostKey(pinned: string, presented: Buffer): boolean {
  const parsed = parseHostKey(pinned);
  if (parsed === undefined) {
    return false;
  }
  return parsed.kind === 'fingerprint'
    ? base64(createHash('sha256').update(presented).digest()) === parsed.digest
    : parsed.blob.equals(presented);
}
