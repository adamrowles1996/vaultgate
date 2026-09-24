import { describe, expect, it } from 'vitest';

import { fakeTlsSocket, fakeTlsSocketWithoutCertificate } from '../test-support/fake-tls-socket.ts';

import {
  certificateDigest,
  guardCertificate,
  pinnedCertificateCheck,
  tlsConnection,
  type CertificateGuard,
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

/**
Collects what the guard hands back, which is what a channel binding is computed over.
*/
function guard(check: CertificateGuard['check'], recorded: Buffer[] = []): CertificateGuard {
  return {
    check,
    record: (certificate) => {
      recorded.push(certificate);
    },
  };
}

describe('guardCertificate', () => {
  it('ACT-57 corks the socket at once and uncorks it only after the certificate passes', () => {
    const socket = fakeTlsSocket(LEAF);
    const guarded = guardCertificate(socket, guard(accepts));
    expect(guarded).toBe(socket);
    expect(socket.events).toStrictEqual(['cork']);
    socket.handshake();
    expect(socket.events).toStrictEqual(['cork', 'secureConnect', 'uncork']);
    expect(socket.destroyedWith).toStrictEqual([]);
  });

  it('ACT-57 destroys the socket with the check error and never uncorks it on a mismatch', () => {
    const socket = fakeTlsSocket(LEAF);
    const refusal = new Error('refused');
    guardCertificate(
      socket,
      guard(() => refusal),
    );
    socket.handshake();
    expect(socket.events).toStrictEqual(['cork', 'secureConnect', 'destroy']);
    expect(socket.destroyedWith).toStrictEqual([refusal]);
  });

  it('ACT-57 T33 refuses a peer that presented no certificate instead of throwing in the listener', () => {
    const socket = fakeTlsSocketWithoutCertificate();
    let wasChecked = false;
    const recordingCheck = (): undefined => {
      wasChecked = true;
    };
    guardCertificate(socket, guard(recordingCheck));
    // Asking the digest of nothing would throw here, and a throw inside a
    // socket event listener is an uncaught exception, not a failed call.
    expect(() => {
      socket.handshake();
    }).not.toThrow();
    expect(wasChecked).toBe(false);
    expect(socket.events).toStrictEqual(['cork', 'secureConnect', 'destroy']);
    expect(socket.destroyedWith[0]).toMatchObject({
      code: 'ERR_TLS_CERT_PIN_MISMATCH',
      message: 'the destination presented no certificate',
    });
  });

  it('ACT-57 leaves the socket corked when the handshake never completes', () => {
    const socket = fakeTlsSocket(LEAF);
    guardCertificate(socket, guard(accepts));
    expect(socket.events).toStrictEqual(['cork']);
  });

  it('ACT-89 hands the leaf certificate back, which is what a channel binding is taken over', () => {
    const recorded: Buffer[] = [];
    const socket = fakeTlsSocket(LEAF);
    guardCertificate(socket, guard(accepts, recorded));
    socket.handshake();
    expect(recorded).toStrictEqual([LEAF]);
  });

  it('ACT-57 asks for no record on a connection nothing will keep', () => {
    const socket = fakeTlsSocket(LEAF);
    guardCertificate(socket, { check: accepts, record: undefined });
    socket.handshake();
    expect(socket.events).toStrictEqual(['cork', 'secureConnect', 'uncork']);
  });

  it('ACT-89 records nothing when the peer presented no certificate', () => {
    const recorded: Buffer[] = [];
    const socket = fakeTlsSocketWithoutCertificate();
    guardCertificate(socket, guard(undefined, recorded));
    socket.handshake();
    expect(recorded).toStrictEqual([]);
  });

  it('ACT-57 never corks an unpinned socket, which the system store is already verifying', () => {
    const recorded: Buffer[] = [];
    const socket = fakeTlsSocket(LEAF);
    guardCertificate(socket, guard(undefined, recorded));
    expect(socket.events).toStrictEqual([]);
    socket.handshake();
    expect(socket.events).toStrictEqual(['secureConnect']);
    expect(socket.destroyedWith).toStrictEqual([]);
    expect(recorded).toStrictEqual([LEAF]);
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

function connecting(): { readonly options: ConnectionOptions[]; readonly connect: TlsConnect } {
  const options: ConnectionOptions[] = [];
  return {
    options,
    connect: (given) => {
      options.push(given);
      return fakeTlsSocket(LEAF);
    },
  };
}

describe('tlsConnection', () => {
  it('ACT-55 ACT-57 connects to the pinned address with the host name as the server name', () => {
    const { options, connect } = connecting();
    const pin = pinnedCertificateCheck(certificateDigest(LEAF));
    const connection = tlsConnection(connect, {
      address: '93.184.216.34',
      port: 5986,
      servername: 'win.example.com',
      guard: guard(pin),
    });
    expect(options).toStrictEqual([]);
    const opened = connection();
    expect(options).toStrictEqual([
      {
        host: '93.184.216.34',
        port: 5986,
        servername: 'win.example.com',
        rejectUnauthorized: false,
      },
    ]);
    expect(opened).toBeDefined();
  });

  it('ACT-57 leaves an unpinned connection to the system store', () => {
    const { options, connect } = connecting();
    tlsConnection(connect, {
      address: '93.184.216.34',
      port: 5986,
      servername: 'win.example.com',
      guard: guard(undefined),
    })();
    expect(options).toStrictEqual([
      {
        host: '93.184.216.34',
        port: 5986,
        servername: 'win.example.com',
        rejectUnauthorized: true,
      },
    ]);
  });
});
