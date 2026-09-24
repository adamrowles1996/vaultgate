/**
 * Certificate pinning for the pinned transport (ACT-57). A destination
 * document may name the SHA-256 of the leaf certificate it will present; that
 * pin then *replaces* the system trust store, which is what makes it useful —
 * the hosts it is meant for (a WinRM listener with its own certificate)
 * present a certificate no public authority signed. It is never an "ignore
 * certificate errors" switch: the socket is corked from the moment it is
 * created and is uncorked only once the certificate the server presented is
 * the pinned one, so not one byte of the request — least of all the
 * credential — reaches a host that fails the check, and a handshake that
 * never completes leaves the socket corked until the call's timeout.
 */
import { createHash } from 'node:crypto';

import type { Duplex } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';

/**
Why the certificate is refused, or `undefined` when it is the pinned one.
*/
export type CertificateCheck = (certificate: Buffer) => Error | undefined;

/**
The part of a TLS socket the guard touches; a test drives it with a fake.
*/
export interface GuardedSocket {
  cork(): void;
  uncork(): void;
  destroy(error?: Error): void;
  once(event: 'secureConnect', listener: () => void): unknown;
  getPeerCertificate(): { readonly raw: Buffer };
}

/**
What a TLS connection has to offer the guard: a duplex stream that can name its peer.
*/
export type PinnedTlsSocket = Duplex & GuardedSocket;

/**
`tls.connect`, injected so the guard is tested without a socket.
*/
export type TlsConnect = (options: ConnectionOptions) => PinnedTlsSocket;

export interface PinnedConnection {
  /**
  ACT-55: the address the engine resolved and validated; the socket goes here.
  */
  readonly address: string;
  readonly port: number;
  /**
  ACT-55: the URL's host name, kept for SNI so the server picks the right certificate.
  */
  readonly servername: string;
  readonly check: CertificateCheck;
}

/**
 * Holds the request until the leaf certificate has been checked, and fails
 * the connection with the check's own error when it is not the pinned one.
 */
export function guardCertificate<Socket extends GuardedSocket>(
  socket: Socket,
  check: CertificateCheck,
): Socket {
  socket.cork();
  socket.once('secureConnect', () => {
    const problem = check(socket.getPeerCertificate().raw);
    if (problem === undefined) {
      socket.uncork();
      return;
    }
    socket.destroy(problem);
  });
  return socket;
}

/**
 * The `createConnection` an `https.request` uses when its destination is
 * pinned to a certificate: the socket goes to the validated address, the host
 * name is the TLS server name only, and the chain is judged by the pin rather
 * than by the system store.
 */
export function pinnedConnection(connect: TlsConnect, plan: PinnedConnection): () => Duplex {
  return () =>
    guardCertificate(
      connect({
        host: plan.address,
        port: plan.port,
        servername: plan.servername,
        // The pin is the verification (ACT-57); `guardCertificate` writes nothing until it passes.
        rejectUnauthorized: false,
      }),
      plan.check,
    );
}

const PIN_MISMATCH_CODE = 'ERR_TLS_CERT_PIN_MISMATCH';

/**
The SHA-256 of a DER certificate, lower-case hex, as `certificate_sha256` is written.
*/
export function certificateDigest(certificate: Buffer): string {
  return createHash('sha256').update(certificate).digest('hex');
}

/**
 * A check for one pinned digest. The error carries a `code` the TLS rule of
 * `tls-error.ts` recognises, so a mismatch is `tls_error` like any other
 * certificate failure and the detail never names the host.
 */
export function pinnedCertificateCheck(digest: string): CertificateCheck {
  const pinned = digest.toLowerCase();
  return (certificate) =>
    certificateDigest(certificate) === pinned
      ? undefined
      : Object.assign(new Error('the certificate is not the pinned one'), {
          code: PIN_MISMATCH_CODE,
        });
}
