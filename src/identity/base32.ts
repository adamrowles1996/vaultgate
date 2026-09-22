/**
 * RFC 4648 §6 base32 (upper-case alphabet, `=` padding), as used by
 * `otpauth://` secrets and recovery codes. Decoding accepts lower case and
 * ignores padding; any other character is a decode failure.
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

/**
Draws `length` characters of the alphabet from a random source.
*/
export function randomBase32(bytes: Buffer): string {
  return [...bytes].map((byte) => ALPHABET.charAt(byte % ALPHABET.length)).join('');
}
