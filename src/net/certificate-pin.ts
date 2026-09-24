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
  /**
  Empty when the peer sent no certificate, which the guard treats as a failed check.
  */
  getPeerCertificate(): { readonly raw?: Buffer | undefined };
}

/**
What a TLS connection has to offer the guard: a duplex stream that can name its peer.
*/
export type PinnedTlsSocket = Duplex & GuardedSocket;

/**
`tls.connect`, injected so the guard is tested without a socket.
*/
export type TlsConnect = (options: ConnectionOptions) => PinnedTlsSocket;

/**
 * What the guard does with the certificate the peer presents: judge it, when
 * the destination named a pin, and hand it to the caller either way — an NTLM
 * exchange over this connection binds itself to that certificate (RFC 5929),
 * and it can only be read here, from the socket that presented it.
 */
export interface CertificateGuard {
  /**
  ACT-57: replaces the system store, or `undefined` to leave the store in charge.
  */
  readonly check: CertificateCheck | undefined;
  /**
  `undefined` for a request that keeps no connection: its socket outlives nothing that could use one.
  */
  readonly record: ((certificate: Buffer) => void) | undefined;
}

export interface TlsPlan {
  /**
  ACT-55: the address the engine resolved and validated; the socket goes here.
  */
  readonly address: string;
  readonly port: number;
  /**
  ACT-55: the URL's host name, kept for SNI so the server picks the right certificate.
  */
  readonly servername: string;
  readonly guard: CertificateGuard;
}

/**
The pin's verdict: uncork on a match, and fail the connection with its own error otherwise.
*/
function judge(socket: GuardedSocket, check: CertificateCheck, raw: Buffer | undefined): void {
  // A peer that sent no certificate has not satisfied the pin, and asking the
  // digest of nothing would throw inside the listener, which is an uncaught
  // exception rather than a failed call (T33).
  const problem = raw === undefined ? missingCertificate() : check(raw);
  if (problem === undefined) {
    socket.uncork();
    return;
  }
  socket.destroy(problem);
}

/**
 * Records the leaf certificate the peer presents and, where the destination
 * named a pin, holds the request corked until that certificate has passed it.
 * An unpinned socket is never corked: the system store is verifying it, and
 * nothing here would add to that.
 */
export function guardCertificate<Socket extends GuardedSocket>(
  socket: Socket,
  guard: CertificateGuard,
): Socket {
  const { check } = guard;
  if (check !== undefined) {
    socket.cork();
  }
  socket.once('secureConnect', () => {
    const { raw } = socket.getPeerCertificate();
    if (raw !== undefined) {
      guard.record?.(raw);
    }
    if (check !== undefined) {
      judge(socket, check, raw);
    }
  });
  return socket;
}

/**
 * The `createConnection` an `https.request` uses when its destination holds
 * its socket or pins its certificate: the socket goes to the validated
 * address, the host name is the TLS server name only, and the chain is judged
 * by the pin where there is one and by the system store where there is not.
 */
export function tlsConnection(connect: TlsConnect, plan: TlsPlan): () => Duplex {
  return () =>
    guardCertificate(
      connect({
        host: plan.address,
        port: plan.port,
        servername: plan.servername,
        // A pin *is* the verification (ACT-57), and `guardCertificate` writes
        // nothing until it passes; without one the system store verifies.
        rejectUnauthorized: plan.guard.check === undefined,
      }),
      plan.guard,
    );
}

const PIN_MISMATCH_CODE = 'ERR_TLS_CERT_PIN_MISMATCH';

/**
The pin's failure when the peer offered nothing to compare it with.
*/
function missingCertificate(): Error {
  return Object.assign(new Error('the destination presented no certificate'), {
    code: PIN_MISMATCH_CODE,
  });
}

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
