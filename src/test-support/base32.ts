/**
 * RFC 4648 §6 base32 decoding, the inverse of `src/identity/base32.ts`:
 * accepts lower case and ignores padding; any other character is a decode
 * failure. Only tests decode (to compute TOTP codes from the enrolment key),
 * so it lives here rather than in the server.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BITS_PER_CHAR = 5;
const BITS_PER_BYTE = 8;

export function base32Decode(text: string): Buffer | undefined {
  const cleaned = text.toUpperCase().replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of cleaned) {
    const value = ALPHABET.indexOf(character);
    if (value === -1) {
      return undefined;
    }
    buffer = ((buffer << BITS_PER_CHAR) | value) & 0xff_ff;
    bits += BITS_PER_CHAR;
    if (!(bits >= BITS_PER_BYTE)) {
      continue;
    }

    bits -= BITS_PER_BYTE;
    bytes.push((buffer >>> bits) & 0xff);
  }
  return Buffer.from(bytes);
}
