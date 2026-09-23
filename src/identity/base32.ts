/**
 * RFC 4648 §6 base32 encoding (upper-case alphabet, `=` padding), as used by
 * `otpauth://` secrets and recovery codes. Nothing in the server decodes;
 * the test-support decoder proves the round trip.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BITS_PER_CHAR = 5;
const BITS_PER_BYTE = 8;
const CHARS_PER_GROUP = 8;

export function base32Encode(bytes: Buffer): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_CHAR) {
      bits -= BITS_PER_CHAR;
      output += ALPHABET.charAt((buffer >>> bits) & 0x1f);
    }
  }
  if (bits > 0) {
    output += ALPHABET.charAt((buffer << (BITS_PER_CHAR - bits)) & 0x1f);
  }
  const remainder = output.length % CHARS_PER_GROUP;
  return remainder === 0 ? output : output + '='.repeat(CHARS_PER_GROUP - remainder);
}

/**
Draws `length` characters of the alphabet from a random source.
*/
export function randomBase32(bytes: Buffer): string {
  return [...bytes].map((byte) => ALPHABET.charAt(byte % ALPHABET.length)).join('');
}
