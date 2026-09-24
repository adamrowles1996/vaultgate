/**
 * A TLS socket for the certificate-pin tests (ACT-57): a real duplex stream,
 * so the guard's `cork`/`uncork` and its `secureConnect` listener behave as
 * they do on the wire, with every call recorded and the handshake driven by
 * the test rather than by a server.
 */
import { Duplex } from 'node:stream';

import type { PinnedTlsSocket } from '../net/certificate-pin.ts';

export class FakeTlsSocket extends Duplex implements PinnedTlsSocket {
  readonly #certificate: Buffer;
  /**
  `cork`, `uncork`, `secureConnect` and `destroy` in the order they happened.
  */
  readonly events: string[] = [];
  readonly destroyedWith: (Error | null | undefined)[] = [];

  constructor(certificate: Buffer) {
    super();
    this.#certificate = certificate;
  }

  override cork(): void {
    this.events.push('cork');
  }

  override uncork(): void {
    this.events.push('uncork');
  }

  override destroy(error?: Error | null): this {
    this.events.push('destroy');
    this.destroyedWith.push(error);
    return this;
  }

  getPeerCertificate(): { readonly raw: Buffer } {
    return { raw: this.#certificate };
  }

  /**
  The handshake completing: what makes Node's TLS socket emit `secureConnect`.
  */
  handshake(): void {
    this.events.push('secureConnect');
    this.emit('secureConnect');
  }
}

export function fakeTlsSocket(certificate: Buffer = Buffer.alloc(0)): FakeTlsSocket {
  return new FakeTlsSocket(certificate);
}
