/**
 * The strict reader for the bytes a destination sends during an NTLM exchange
 * (T33). A challenge arrives from the far end of the connection before
 * anything has been authenticated, so every offset and every length in it is
 * attacker-controlled: each one is checked against the buffer before a byte is
 * read, and a field that does not fit is refused outright rather than clamped,
 * exactly as `../xml.ts` refuses a response it cannot read. Nothing here ever
 * throws anything but an `NtlmProblem`, which the transport turns into
 * `upstream_error`; a malformed message is never a crash.
 */
export class NtlmProblem extends Error {
  constructor(reason: string) {
    super(`the destination's encrypted exchange is not readable: ${reason}`);
    this.name = 'NtlmProblem';
  }
}

const U16_BYTES = 2;
const U32_BYTES = 4;

export class Bytes {
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  /**
  Both values come off the wire as unsigned, so the only way out of the buffer is past its end.
  */
  #room(at: number, length: number, what: string): void {
    if (at + length > this.#bytes.length) {
      throw new NtlmProblem(`${what} lies outside the message`);
    }
  }

  slice(at: number, length: number, what: string): Buffer {
    this.#room(at, length, what);
    return this.#bytes.subarray(at, at + length);
  }

  u16(at: number, what: string): number {
    this.#room(at, U16_BYTES, what);
    return this.#bytes.readUInt16LE(at);
  }

  u32(at: number, what: string): number {
    this.#room(at, U32_BYTES, what);
    return this.#bytes.readUInt32LE(at);
  }

  /**
   * One of NTLM's `(Len, MaxLen, BufferOffset)` triples and the payload it
   * points at (MS-NLMP 2.2.2.5). `MaxLen` is ignored, as the specification
   * says to; `Len` and the offset are both checked against the message.
   */
  field(at: number, what: string): Buffer {
    const length = this.u16(at, what);
    const offset = this.u32(at + U32_BYTES, what);
    return this.slice(offset, length, what);
  }
}
