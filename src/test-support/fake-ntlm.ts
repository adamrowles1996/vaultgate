/**
 * The destination's half of an NTLM exchange, for the `winrm` contract tests
 * (ACT-75, ACT-89). It issues a challenge, verifies the authenticate message
 * against a password it knows — including the MIC — recovers the exported
 * session key, and seals and verifies messages in the opposite direction from
 * the connector.
 *
 * It is written out rather than built on `src/actions/connectors/winrm/ntlm/`
 * so that the contract tests are a check and not an echo: only the two
 * primitives (`md4`, `rc4`), each proved against its own specification's test
 * vectors, are shared. The NTLMv2 arithmetic itself is proved separately
 * against the worked example in MS-NLMP 4.2.4.
 */
import { createHash, createHmac } from 'node:crypto';

import { md4 } from '../crypto/md4.ts';
import { Rc4, rc4 } from '../crypto/rc4.ts';

const SIGNATURE = Buffer.from('NTLMSSP\u{0}', 'latin1');
const KEY_EXCHANGE = 0x40_00_00_00;

const SERVER_FLAGS =
  0x00_00_00_01 | // unicode
  0x00_00_00_04 | // request target
  0x00_00_00_10 | // sign
  0x00_00_00_20 | // seal
  0x00_00_02_00 | // ntlm
  0x00_00_80_00 | // always sign
  0x00_08_00_00 | // extended session security
  0x00_80_00_00 | // target info
  0x02_00_00_00 | // version
  0x20_00_00_00 | // 128-bit
  KEY_EXCHANGE;

export const FAKE_SERVER_CHALLENGE = Buffer.from('0123456789abcdef', 'hex');
export const FAKE_TIMESTAMP = Buffer.from('0011223344556677', 'hex');

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('md5', key).update(data).digest();
}

function attribute(id: number, value: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(value.length, 2);
  return Buffer.concat([head, value]);
}

function field(message: Buffer, at: number, payload: Buffer, offset: number): void {
  message.writeUInt16LE(payload.length, at);
  message.writeUInt16LE(payload.length, at + 2);
  message.writeUInt32LE(offset, at + 4);
}

function readField(message: Buffer, at: number): Buffer {
  const length = message.readUInt16LE(at);
  const offset = message.readUInt32LE(at + 4);
  return message.subarray(offset, offset + length);
}

export interface FakeNtlmOptions {
  readonly password: string;
  /**
  MS-NLMP 3.1.5.1.2: a timestamped challenge is what asks the client for a MIC.
  */
  readonly timestamped?: boolean;
  readonly keyExchange?: boolean;
  /**
  Flags the destination answers with, for the downgrade cases; the supported set by default.
  */
  readonly flags?: number;
}

/**
The destination's session security: the mirror of the connector's, client and server swapped.
*/
export class FakeSecurity {
  readonly #keys: Record<'clientSign' | 'serverSign', Buffer>;
  readonly #client: Rc4;
  readonly #server: Rc4;
  readonly #isKeyExchange: boolean;
  #fromClient = 0;
  #toClient = 0;

  constructor(exported: Buffer, isKeyExchange: boolean) {
    // The destination's key derivation is MD5 for the same reason the
    // connector's is: MS-NLMP 3.4.5.2 says so.
    const sub = (purpose: string): Buffer =>
      createHash('md5')
        .update(Buffer.concat([exported, Buffer.from(`${purpose}\u{0}`, 'ascii')]))
        .digest();
    this.#keys = {
      clientSign: sub('session key to client-to-server signing key magic constant'),
      serverSign: sub('session key to server-to-client signing key magic constant'),
    };
    this.#client = new Rc4(sub('session key to client-to-server sealing key magic constant'));
    this.#server = new Rc4(sub('session key to server-to-client sealing key magic constant'));
    this.#isKeyExchange = isKeyExchange;
  }

  #sign(key: Buffer, cipher: Rc4, message: Buffer, sequence: number): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32LE(sequence, 0);
    const version = Buffer.alloc(4);
    version.writeUInt32LE(1, 0);
    const checksum = hmac(key, Buffer.concat([counter, message])).subarray(0, 8);
    return Buffer.concat([
      version,
      this.#isKeyExchange ? cipher.apply(checksum) : checksum,
      counter,
    ]);
  }

  fromClient(signature: Buffer, sealed: Buffer): Buffer {
    const message = this.#client.apply(sealed);
    const expected = this.#sign(this.#keys.clientSign, this.#client, message, this.#fromClient);
    this.#fromClient += 1;
    if (!expected.equals(signature)) {
      throw new Error('the client signature does not verify');
    }
    return message;
  }

  toClient(message: Buffer): { readonly signature: Buffer; readonly sealed: Buffer } {
    const sealed = this.#server.apply(message);
    const signature = this.#sign(this.#keys.serverSign, this.#server, message, this.#toClient);
    this.#toClient += 1;
    return { signature, sealed };
  }
}

export class FakeNtlm {
  readonly #options: FakeNtlmOptions;
  #negotiate: Buffer = Buffer.alloc(0);
  #challenge: Buffer = Buffer.alloc(0);

  constructor(options: FakeNtlmOptions) {
    this.#options = options;
  }

  #verifyMic(authenticate: Buffer, exported: Buffer): void {
    if (this.#options.timestamped !== true) {
      return;
    }
    const zeroed = Buffer.from(authenticate);
    Buffer.alloc(16).copy(zeroed, 72);
    const expected = hmac(exported, Buffer.concat([this.#negotiate, this.#challenge, zeroed]));
    if (!expected.equals(authenticate.subarray(72, 88))) {
      throw new Error('the client MIC does not verify');
    }
  }

  #flags(): number {
    const offered = this.#options.flags ?? SERVER_FLAGS;
    return this.#options.keyExchange === false ? offered & ~KEY_EXCHANGE : offered;
  }

  /**
  The `CHALLENGE_MESSAGE` this destination answers a negotiate message with.
  */
  challenge(negotiate: Buffer): Buffer {
    this.#negotiate = negotiate;
    const targetName = Buffer.from('SERVER', 'utf16le');
    const info = Buffer.concat([
      attribute(0x00_02, Buffer.from('WORKGROUP', 'utf16le')),
      attribute(0x00_01, targetName),
      ...(this.#options.timestamped === true ? [attribute(0x00_07, FAKE_TIMESTAMP)] : []),
      attribute(0x00_00, Buffer.alloc(0)),
    ]);
    const message = Buffer.alloc(56 + targetName.length + info.length);
    SIGNATURE.copy(message);
    message.writeUInt32LE(2, 8);
    field(message, 12, targetName, 56);
    message.writeUInt32LE(this.#flags() >>> 0, 20);
    FAKE_SERVER_CHALLENGE.copy(message, 24);
    field(message, 40, info, 56 + targetName.length);
    targetName.copy(message, 56);
    info.copy(message, 56 + targetName.length);
    this.#challenge = message;
    return message;
  }

  /**
   * Verifies the `AUTHENTICATE_MESSAGE` the way a Windows host does — the
   * NTLMv2 proof over the server's challenge and the client's blob, then the
   * MIC over all three messages — and returns the session security, or
   * `undefined` when the credential is wrong.
   */
  accept(authenticate: Buffer): FakeSecurity | undefined {
    const nt = readField(authenticate, 20);
    const domain = readField(authenticate, 28);
    const user = readField(authenticate, 36);
    const sessionKey = readField(authenticate, 52);
    const flags = authenticate.readUInt32LE(60);
    const shouted = Buffer.from(user.toString('utf16le').toUpperCase(), 'utf16le');
    const ntHash = md4(Buffer.from(this.#options.password, 'utf16le'));
    const key = hmac(ntHash, Buffer.concat([shouted, domain]));
    const proof = nt.subarray(0, 16);
    const blob = nt.subarray(16);
    if (!hmac(key, Buffer.concat([FAKE_SERVER_CHALLENGE, blob])).equals(proof)) {
      return undefined;
    }
    const base = hmac(key, proof);
    const exported = (flags & KEY_EXCHANGE) === 0 ? base : rc4(base, sessionKey);
    this.#verifyMic(authenticate, exported);
    return new FakeSecurity(exported, (flags & KEY_EXCHANGE) !== 0);
  }
}
