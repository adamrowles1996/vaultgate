/**
 * RC4, as NTLM's session security uses it.
 *
 * **RC4 is broken, and it protects nothing on its own.** It is here for the
 * same reason as `md4.ts`: MS-NLMP defines NTLM's `SEAL` and its
 * key-exchange step in terms of RC4 (3.4.3, 3.4.5.1), so a client that cannot
 * run RC4 cannot seal a WinRM message, and sealing is exactly what a stock
 * Windows host demands when `AllowUnencrypted` is false (ACT-89). OpenSSL 3
 * moved RC4 to the legacy provider, so `node:crypto` cannot supply it.
 *
 * vaultgate never chooses RC4 for anything of its own — stored secrets use
 * AES-256-GCM (`secret-box.ts`). What makes the NTLM exchange worth having is
 * that the password never crosses the network and that the keys are derived
 * per connection from a server-chosen challenge; this cipher is the shape the
 * protocol fixes for the last step, not a security claim.
 *
 * The state is deliberately long-lived: MS-NLMP 3.4.4.2 signs a message with
 * the *same* keystream that sealed it, and each direction of a connection
 * keeps its own handle across every message, so an instance is a running
 * cipher rather than a one-shot function. `rc4.test.ts` proves it against the
 * published RC4 test vectors.
 */
const STATE_BYTES = 256;
const BYTE = 0xff;

export class Rc4 {
  readonly #state: Buffer;
  #from = 0;
  #to = 0;

  constructor(key: Buffer) {
    this.#state = Buffer.alloc(STATE_BYTES);
    for (let index = 0; index < STATE_BYTES; index += 1) {
      this.#state[index] = index;
    }
    let mixed = 0;
    for (let index = 0; index < STATE_BYTES; index += 1) {
      mixed = (mixed + this.#state.readUInt8(index) + key.readUInt8(index % key.length)) & BYTE;
      this.#swap(index, mixed);
    }
  }

  #swap(left: number, right: number): void {
    const held = this.#state.readUInt8(left);
    this.#state.writeUInt8(this.#state.readUInt8(right), left);
    this.#state.writeUInt8(held, right);
  }

  #keystreamByte(): number {
    this.#from = (this.#from + 1) & BYTE;
    this.#to = (this.#to + this.#state.readUInt8(this.#from)) & BYTE;
    this.#swap(this.#from, this.#to);
    const at = (this.#state.readUInt8(this.#from) + this.#state.readUInt8(this.#to)) & BYTE;
    return this.#state.readUInt8(at);
  }

  /**
   * `data` combined by exclusive or with the next `data.length` bytes of the
   * keystream. The instance advances, so sealing a message and then signing
   * it — which is what MS-NLMP 3.4.3 asks for, in that order — continues one
   * keystream.
   */
  apply(data: Buffer): Buffer {
    const out = Buffer.alloc(data.length);
    for (let at = 0; at < data.length; at += 1) {
      out.writeUInt8(data.readUInt8(at) ^ this.#keystreamByte(), at);
    }
    return out;
  }
}

/**
One-shot RC4 with a fresh state, for the single-use key-exchange step of MS-NLMP 3.4.5.1.
*/
export function rc4(key: Buffer, data: Buffer): Buffer {
  return new Rc4(key).apply(data);
}
