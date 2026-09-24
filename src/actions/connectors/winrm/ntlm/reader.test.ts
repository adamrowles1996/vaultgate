import { describe, expect, it } from 'vitest';

import { Bytes, NtlmProblem } from './reader.ts';

const MESSAGE = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

describe('the NTLM byte reader', () => {
  it('T33 reads the little-endian values the protocol writes', () => {
    const bytes = new Bytes(MESSAGE);
    expect(bytes.u16(0, 'a value')).toBe(0x11_00);
    expect(bytes.u32(0, 'a value')).toBe(0x33_22_11_00);
    expect(bytes.slice(4, 4, 'a value').toString('hex')).toBe('44556677');
  });

  it('T33 refuses every read that would run past the end of the message', () => {
    const bytes = new Bytes(MESSAGE);
    expect(() => bytes.u16(15, 'a value')).toThrow(NtlmProblem);
    expect(() => bytes.u32(13, 'a value')).toThrow(NtlmProblem);
    expect(() => bytes.slice(8, 9, 'a payload')).toThrow('a payload lies outside the message');
    expect(() => new Bytes(Buffer.alloc(0)).u16(0, 'a value')).toThrow(NtlmProblem);
  });

  it('T33 bounds-checks both halves of a field triple, the length and the offset', () => {
    // Length 4 at offset 12 fits; the same length at offset 13 does not, and
    // neither does a length the destination inflated.
    const fits = Buffer.alloc(20);
    fits.writeUInt16LE(4, 0);
    fits.writeUInt32LE(12, 4);
    expect(new Bytes(fits).field(0, 'a field')).toStrictEqual(Buffer.alloc(4));
    const past = Buffer.from(fits);
    past.writeUInt32LE(17, 4);
    expect(() => new Bytes(past).field(0, 'a field')).toThrow(NtlmProblem);
    const inflated = Buffer.from(fits);
    inflated.writeUInt16LE(0xff_ff, 0);
    expect(() => new Bytes(inflated).field(0, 'a field')).toThrow(NtlmProblem);
  });

  it('T33 names what it refused without quoting anything the destination sent', () => {
    const problem = new NtlmProblem('the sky is the wrong colour');
    expect(problem.name).toBe('NtlmProblem');
    expect(problem.message).toBe(
      "the destination's encrypted exchange is not readable: the sky is the wrong colour",
    );
  });
});
