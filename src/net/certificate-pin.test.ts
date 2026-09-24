import { describe, expect, it } from 'vitest';

import { fakeTlsSocket } from '../test-support/fake-tls-socket.ts';

import {
  certificateDigest,
  guardCertificate,
  pinnedCertificateCheck,
  pinnedConnection,
  type TlsConnect,
} from './certificate-pin.ts';

import type { ConnectionOptions } from 'node:tls';

const LEAF = Buffer.from('canary-leaf-certificate-der', 'utf8');
const OTHER = Buffer.from('canary-other-certificate-der', 'utf8');

/**
A check that is happy with anything: these tests are about the guard, not the pin.
*/
function accepts(): undefined {
  // Nothing to refuse.
}

describe('guardCertificate', () => {
  it('ACT-57 corks the socket at once and uncorks it only after the certificate passes', () => {
    const socket = fakeTlsSocket(LEAF);
    const guarded = guardCertificate(socket, accepts);
    expect(guarded).toBe(socket);
    expect(socket.events).toStrictEqual(['cork']);
    socket.handshake();
    expect(socket.events).toStrictEqual(['cork', 'secureConnect', 'uncork']);
    expect(socket.destroyedWith).toStrictEqual([]);
  });

  it('ACT-57 destroys the socket with the check error and never uncorks it on a mismatch', () => {
    const socket = fakeTlsSocket(LEAF);
    const refusal = new Error('refused');
    guardCertificate(socket, () => refusal);
    socket.handshake();
    expect(socket.events).toStrictEqual(['cork', 'secureConnect', 'destroy']);
    expect(socket.destroyedWith).toStrictEqual([refusal]);
  });

  it('ACT-57 leaves the socket corked when the handshake never completes', () => {
    const socket = fakeTlsSocket(LEAF);
    guardCertificate(socket, accepts);
    expect(socket.events).toStrictEqual(['cork']);
  });
});

describe('pinnedCertificateCheck', () => {
  it('ACT-57 accepts the pinned digest whatever case it was written in', () => {
    const digest = certificateDigest(LEAF);
    expect(pinnedCertificateCheck(digest.toUpperCase())(LEAF)).toBeUndefined();
    expect(pinnedCertificateCheck(digest)(LEAF)).toBeUndefined();
  });

  it('ACT-57 refuses another certificate with a TLS error code and no host in the message', () => {
    const problem = pinnedCertificateCheck(certificateDigest(LEAF))(OTHER);
    expect(problem).toBeInstanceOf(Error);
    expect(problem?.message).toBe('the certificate is not the pinned one');
    expect(problem).toMatchObject({ code: 'ERR_TLS_CERT_PIN_MISMATCH' });
  });

  it('ACT-57 digests a certificate as lower-case hexadecimal SHA-256', () => {
    expect(certificateDigest(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('pinnedConnection', () => {
  it('ACT-55 ACT-57 connects to the pinned address with the host name as the server name', () => {
    const options: ConnectionOptions[] = [];
    const socket = fakeTlsSocket(LEAF);
    const connect: TlsConnect = (given) => {
      options.push(given);
      return socket;
    };
    const connection = pinnedConnection(connect, {
      address: '93.184.216.34',
      port: 5986,
      servername: 'win.example.com',
      check: pinnedCertificateCheck(certificateDigest(LEAF)),
    });
    expect(options).toStrictEqual([]);
    const opened = connection();
    expect(opened).toBe(socket);
    expect(options).toStrictEqual([
      {
        host: '93.184.216.34',
        port: 5986,
        servername: 'win.example.com',
        rejectUnauthorized: false,
      },
    ]);
    socket.handshake();
    expect(socket.events).toStrictEqual(['cork', 'secureConnect', 'uncork']);
  });
});
