import { describe, expect, it } from 'vitest';

import {
  fakeTlsSocket,
  fakeTlsSocketWithoutCertificate,
  type FakeTlsSocket,
} from '../test-support/fake-tls-socket.ts';
import { certificateNaming, TEST_CERTIFICATE_PEM } from '../test-support/test-certificate.ts';

import {
  certificateDigest,
  guardCertificate,
  pinnedCertificateCheck,
  tlsConnection,
  type CertificateGuard,
  type TlsConnect,
} from './certificate-pin.ts';
import { isTlsErrorCode } from './tls-error.ts';

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

interface Connecting {
  readonly options: ConnectionOptions[];
  readonly sockets: FakeTlsSocket[];
  readonly connect: TlsConnect;
}

function connecting(): Connecting {
  const options: ConnectionOptions[] = [];
  const sockets: FakeTlsSocket[] = [];
  return {
    options,
    sockets,
    connect: (given) => {
      options.push(given);
      const socket = fakeTlsSocket(LEAF);
      sockets.push(socket);
      return socket;
    },
  };
}

const PEM = TEST_CERTIFICATE_PEM;
const NODE_ADDRESS = '192.0.2.10';

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

  it('ACT-122 hands a private authority to Node, which verifies the chain and the host name itself', () => {
    const { options, sockets, connect } = connecting();
    tlsConnection(connect, {
      address: NODE_ADDRESS,
      port: 8006,
      servername: 'pve.example.internal',
      guard: guard(undefined),
      ca: PEM,
    })();
    expect(options).toStrictEqual([
      {
        host: NODE_ADDRESS,
        port: 8006,
        servername: 'pve.example.internal',
        rejectUnauthorized: true,
        ca: PEM,
      },
    ]);
    // Node refuses the chain before the request is written; nothing is held back here.
    expect(sockets[0]?.events).toStrictEqual([]);
  });

  it('ACT-55 ACT-122 never sends an address as SNI and checks the certificate against that address instead', () => {
    const { options, connect } = connecting();
    const plan = { port: 8006, guard: guard(undefined), ca: PEM };
    tlsConnection(connect, { ...plan, address: NODE_ADDRESS, servername: NODE_ADDRESS })();
    tlsConnection(connect, { ...plan, address: '2001:db8::10', servername: '2001:db8::10' })();
    const [v4, v6] = options;
    expect(v4).not.toHaveProperty('servername');
    expect(v4).toMatchObject({ host: NODE_ADDRESS, rejectUnauthorized: true, ca: PEM });
    expect(v6).not.toHaveProperty('servername');
    // Node hands the check whatever the socket connected to; the verdict is about the URL's address.
    expect(
      v4?.checkServerIdentity?.('198.51.100.7', certificateNaming(`IP Address:${NODE_ADDRESS}`)),
    ).toBeUndefined();
    expect(
      v6?.checkServerIdentity?.('x', certificateNaming('IP Address:2001:DB8:0:0:0:0:0:10')),
    ).toBeUndefined();
    const refusals = [
      v4?.checkServerIdentity?.(NODE_ADDRESS, certificateNaming('IP Address:192.0.2.11')),
      v4?.checkServerIdentity?.(NODE_ADDRESS, certificateNaming('DNS:pve.example.internal')),
    ];
    expect(refusals).toMatchObject([
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    ]);
    expect(isTlsErrorCode('ERR_TLS_CERT_ALTNAME_INVALID')).toBe(true);
  });

  it('ACT-57 ACT-89 sends no address as SNI on a pinned connection either, which Node would refuse outright', () => {
    const { options, connect } = connecting();
    tlsConnection(connect, {
      address: NODE_ADDRESS,
      port: 5986,
      servername: NODE_ADDRESS,
      guard: guard(accepts),
    })();
    expect(options[0]).not.toHaveProperty('servername');
    expect(options[0]).toMatchObject({ host: NODE_ADDRESS, port: 5986, rejectUnauthorized: false });
    expect(options[0]).not.toHaveProperty('ca');
  });

  it('ACT-121 ACT-122 holds a plan that names both a pin and an authority to both, never to the looser', () => {
    const { options, sockets, connect } = connecting();
    tlsConnection(connect, {
      address: NODE_ADDRESS,
      port: 8006,
      servername: 'pve.example.internal',
      guard: guard(accepts),
      ca: PEM,
    })();
    expect(options[0]).toMatchObject({ rejectUnauthorized: true, ca: PEM });
    expect(sockets[0]?.events).toStrictEqual(['cork']);
  });
});
