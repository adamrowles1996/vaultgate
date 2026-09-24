/**
 * NTLM session security with extended session security (MS-NLMP 3.4): the
 * four sub-keys derived from the exported session key, one running RC4 handle
 * and one sequence number per direction, and the 16-byte signature that goes
 * with every sealed message.
 *
 * Two details are easy to get wrong and are what the tests pin. The message
 * is sealed *before* its signature is computed, because the checksum is
 * encrypted with the same keystream and therefore has to follow the payload
 * through it (3.4.3). And each direction keeps its own handle and its own
 * counter: a reply is not verifiable with the request's state, and a message
 * that arrives out of order fails, which is the replay protection the whole
 * construction exists for.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { Rc4 } from '../../../../crypto/rc4.ts';

import { hmacMd5 } from './ntlmv2.ts';
import { NtlmProblem } from './reader.ts';

const SIGNATURE_BYTES = 16;
const CHECKSUM_BYTES = 8;
const COUNTER_BYTES = 4;
const SIGNATURE_VERSION = 1;

type Party = 'client-to-server' | 'server-to-client';

export interface SealedMessage {
  readonly signature: Buffer;
  readonly sealed: Buffer;
}

/**
MS-NLMP 3.4.5.2, 3.4.5.3: the constants are part of the key, trailing NUL included.
*/
function subKey(exportedSessionKey: Buffer, purpose: string): Buffer {
  return createHash('md5')
    .update(Buffer.concat([exportedSessionKey, Buffer.from(`${purpose}\u{0}`, 'ascii')]))
    .digest();
}

class Direction {
  readonly #signKey: Buffer;
  readonly #cipher: Rc4;
  readonly #isKeyExchange: boolean;
  #sequence = 0;

  constructor(exportedSessionKey: Buffer, party: Party, isKeyExchange: boolean) {
    this.#signKey = subKey(
      exportedSessionKey,
      `session key to ${party} signing key magic constant`,
    );
    this.#cipher = new Rc4(
      subKey(exportedSessionKey, `session key to ${party} sealing key magic constant`),
    );
    this.#isKeyExchange = isKeyExchange;
  }

  /**
  RC4 is symmetric, so this both seals an outgoing message and unseals an incoming one.
  */
  apply(bytes: Buffer): Buffer {
    return this.#cipher.apply(bytes);
  }

  /**
   * MS-NLMP 3.4.4.2 over the *plaintext*, with the sequence number the message
   * is numbered with; the counter advances once per message either way.
   */
  sign(message: Buffer): Buffer {
    const counter = Buffer.alloc(COUNTER_BYTES);
    counter.writeUInt32LE(this.#sequence, 0);
    const version = Buffer.alloc(COUNTER_BYTES);
    version.writeUInt32LE(SIGNATURE_VERSION, 0);
    const checksum = hmacMd5(this.#signKey, Buffer.concat([counter, message])).subarray(
      0,
      CHECKSUM_BYTES,
    );
    this.#sequence += 1;
    return Buffer.concat([
      version,
      this.#isKeyExchange ? this.#cipher.apply(checksum) : checksum,
      counter,
    ]);
  }
}

export class NtlmSecurity {
  readonly #client: Direction;
  readonly #server: Direction;

  constructor(exportedSessionKey: Buffer, isKeyExchange: boolean) {
    this.#client = new Direction(exportedSessionKey, 'client-to-server', isKeyExchange);
    this.#server = new Direction(exportedSessionKey, 'server-to-client', isKeyExchange);
  }

  seal(message: Buffer): SealedMessage {
    const sealed = this.#client.apply(message);
    return { signature: this.#client.sign(message), sealed };
  }

  /**
   * The message the destination sealed, or an `NtlmProblem`. A signature that
   * does not verify — a forged one, a replayed one, or one for a message that
   * was altered in flight — fails the call; there is no best-effort decode.
   */
  unseal(signature: Buffer, sealed: Buffer): Buffer {
    if (signature.length !== SIGNATURE_BYTES) {
      throw new NtlmProblem('the message signature is not sixteen bytes');
    }
    const message = this.#server.apply(sealed);
    if (!timingSafeEqual(this.#server.sign(message), signature)) {
      throw new NtlmProblem('the message signature does not match what the destination sent');
    }
    return message;
  }
}
