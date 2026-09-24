/**
 * MD4 (RFC 1320).
 *
 * **MD4 is broken, and it protects nothing here.** It is in this repository
 * for exactly one reason: NTLM defines the NT hash as `MD4(UTF-16LE(password))`
 * (MS-NLMP 3.3.2), so a client that cannot compute MD4 cannot speak NTLM at
 * all, and NTLM is what lets the `winrm` connector reach a stock Windows host
 * without asking its owner to turn on `Basic` (ACT-89). OpenSSL 3 removed MD4
 * from its default provider, so `node:crypto` cannot supply it and it has to
 * be written out.
 *
 * Nothing in vaultgate chooses MD4: it hashes no password of its own with it,
 * stores no MD4 digest, and exposes it to no caller but the NTLM code. The
 * security of a `winrm` call rests on the challenge-response construction
 * (the password never crosses the network), on the HMAC-MD5 chain over a
 * server-chosen challenge, and on the session key derived from it — not on
 * this function's collision resistance, which is nil. Do not reach for it for
 * anything else; `node:crypto` has real hashes.
 *
 * The implementation is the RFC's, and `md4.test.ts` proves it against the
 * RFC's own test vectors rather than against another implementation.
 */
const BLOCK_BYTES = 64;
const LENGTH_BYTES = 8;
const WORD_BYTES = 4;
const DIGEST_BYTES = 16;
const BITS_PER_BYTE = 8n;
const WORD_BITS = 32;
const END_MARKER = 0x80;

/**
The four registers A, B, C, D, in that order.
*/
type State = readonly [number, number, number, number];

/**
Word `index` of the block being compressed (RFC 1320's `X[k]`).
*/
type Word = (index: number) => number;

type Mix = (x: number, y: number, z: number) => number;

/**
One operation: which word it folds in, and how far the result is rotated.
*/
type Step = readonly [number, number];

interface Round {
  readonly schedule: readonly Step[];
  readonly mix: Mix;
  /**
  The round's additive constant; RFC 1320 calls the two non-zero ones "magic".
  */
  readonly added: number;
}

const INITIAL: State = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76];

const ROUND_ONE: readonly Step[] = [
  [0, 3],
  [1, 7],
  [2, 11],
  [3, 19],
  [4, 3],
  [5, 7],
  [6, 11],
  [7, 19],
  [8, 3],
  [9, 7],
  [10, 11],
  [11, 19],
  [12, 3],
  [13, 7],
  [14, 11],
  [15, 19],
];

const ROUND_TWO: readonly Step[] = [
  [0, 3],
  [4, 5],
  [8, 9],
  [12, 13],
  [1, 3],
  [5, 5],
  [9, 9],
  [13, 13],
  [2, 3],
  [6, 5],
  [10, 9],
  [14, 13],
  [3, 3],
  [7, 5],
  [11, 9],
  [15, 13],
];

const ROUND_THREE: readonly Step[] = [
  [0, 3],
  [8, 9],
  [4, 11],
  [12, 15],
  [2, 3],
  [10, 9],
  [6, 11],
  [14, 15],
  [1, 3],
  [9, 9],
  [5, 11],
  [13, 15],
  [3, 3],
  [11, 9],
  [7, 11],
  [15, 15],
];

const ROUNDS: readonly Round[] = [
  { schedule: ROUND_ONE, mix: (x, y, z) => (x & y) | (~x & z), added: 0 },
  { schedule: ROUND_TWO, mix: (x, y, z) => (x & y) | (x & z) | (y & z), added: 0x5a_82_79_99 },
  { schedule: ROUND_THREE, mix: (x, y, z) => x ^ y ^ z, added: 0x6e_d9_eb_a1 },
];

function rotate(value: number, by: number): number {
  return ((value << by) | (value >>> (WORD_BITS - by))) >>> 0;
}

/**
 * RFC 1320 §3.1: the message, a single `1` bit, zeroes up to eight bytes short
 * of a block, and the original length in bits as a little-endian 64-bit value.
 */
function pad(data: Buffer): Buffer {
  const tail = data.length % BLOCK_BYTES;
  const blocks = (data.length - tail) / BLOCK_BYTES + (tail < BLOCK_BYTES - LENGTH_BYTES ? 1 : 2);
  const padded = Buffer.alloc(blocks * BLOCK_BYTES);
  data.copy(padded);
  padded.writeUInt8(END_MARKER, data.length);
  padded.writeBigUInt64LE(BigInt(data.length) * BITS_PER_BYTE, padded.length - LENGTH_BYTES);
  return padded;
}

/**
 * One round over the four registers. Each step replaces the leading register
 * and rotates the four, which is how RFC 1320's `[ABCD k s]` notation walks
 * `a, d, c, b` without naming them.
 */
function round(state: State, word: Word, spec: Round): State {
  let [a, b, c, d] = state;
  for (const [index, by] of spec.schedule) {
    [a, b, c, d] = [d, rotate((a + spec.mix(b, c, d) + word(index) + spec.added) >>> 0, by), b, c];
  }
  return [a, b, c, d];
}

function compress(state: State, word: Word): State {
  const [a, b, c, d] = ROUNDS.reduce<State>((current, spec) => round(current, word, spec), state);
  return [(state[0] + a) >>> 0, (state[1] + b) >>> 0, (state[2] + c) >>> 0, (state[3] + d) >>> 0];
}

function wordsOf(padded: Buffer, at: number): Word {
  return (index) => padded.readUInt32LE(at + index * WORD_BYTES);
}

/**
The 16-byte MD4 digest of `data`. See this module's header before using it.
*/
export function md4(data: Buffer): Buffer {
  const padded = pad(data);
  let state = INITIAL;
  for (let at = 0; at < padded.length; at += BLOCK_BYTES) {
    state = compress(state, wordsOf(padded, at));
  }
  const digest = Buffer.alloc(DIGEST_BYTES);
  for (const [index, value] of state.entries()) {
    digest.writeUInt32LE(value, index * WORD_BYTES);
  }
  return digest;
}
