import { Agent } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { fakeTlsSocket } from '../test-support/fake-tls-socket.ts';
import { certificateNaming, TEST_CERTIFICATE_PEM } from '../test-support/test-certificate.ts';

import { KeptConnection } from './kept-connection.ts';
import {
  createPinnedHttpsFetch,
  type PinnedRequest,
  type RequestFunction,
} from './pinned-https.ts';

import type { TlsConnect } from './certificate-pin.ts';
import type { RequestOptions } from 'node:https';
import type { ConnectionOptions } from 'node:tls';

const PEM = TEST_CERTIFICATE_PEM;

function ignore(): void {
  // The request is finished with as soon as the agent has been chosen.
}

interface Wire {
  readonly given: RequestOptions[];
  readonly opened: ConnectionOptions[];
  readonly fetch: ReturnType<typeof createPinnedHttpsFetch>;
}

/**
A transport whose requests answer an empty 200 and whose TLS sockets are fakes, both recorded.
*/
function wire(): Wire {
  const given: RequestOptions[] = [];
  const opened: ConnectionOptions[] = [];
  const request: RequestFunction = (_url, options, callback) => {
    given.push(options);
    callback(Object.assign(Readable.from([]), { statusCode: 200, headers: {} }));
    return { once: ignore, end: ignore };
  };
  const connect: TlsConnect = (options) => {
    opened.push(options);
    return fakeTlsSocket();
  };
  return { given, opened, fetch: createPinnedHttpsFetch({ https: request, connect }) };
}

function pinned(overrides: Partial<PinnedRequest>): PinnedRequest {
  return {
    url: 'https://pve.example.internal:8006/api2/json/version',
    address: '192.0.2.10',
    method: 'GET',
    headers: {},
    signal: AbortSignal.timeout(4000),
    ...overrides,
  };
}

/**
Asks the request's agent for its socket, as Node does, and answers with the options it was opened with.
*/
function socketOptions(recorded: Wire, index: number): ConnectionOptions | undefined {
  const agent = recorded.given[index]?.agent;
  if (!(agent instanceof Agent)) {
    throw new TypeError('the request runs on no agent of its own');
  }
  agent.createConnection({});
  return recorded.opened.at(-1);
}

describe('the pinned transport with a private authority', () => {
  it('ACT-122 gives the request an agent of its own, whose socket Node verifies against the authority alone', async () => {
    const recorded = wire();
    await recorded.fetch(pinned({ ca: PEM }));
    expect(recorded.opened).toStrictEqual([]);
    expect(socketOptions(recorded, 0)).toStrictEqual({
      host: '192.0.2.10',
      port: 8006,
      servername: 'pve.example.internal',
      rejectUnauthorized: true,
      ca: PEM,
    });
  });

  it('ACT-55 ACT-122 names an IPv6 literal without its brackets, never as SNI, and checks the certificate against it', async () => {
    const recorded = wire();
    await recorded.fetch(
      pinned({ url: 'https://[2001:db8::10]:8006/api2/json', address: '2001:db8::10', ca: PEM }),
    );
    const options = socketOptions(recorded, 0);
    expect(options).toMatchObject({ host: '2001:db8::10', port: 8006, rejectUnauthorized: true });
    expect(options).not.toHaveProperty('servername');
    const certificate = certificateNaming('IP Address:2001:DB8:0:0:0:0:0:10');
    expect(options?.checkServerIdentity?.('2001:db8::10', certificate)).toBeUndefined();
  });

  it('ACT-55 ACT-89 opens a kept connection to an address without SNI too, verified against that address', async () => {
    const recorded = wire();
    const kept = new KeptConnection();
    await recorded.fetch(
      pinned({ url: 'https://192.0.2.20:5986/wsman', address: '192.0.2.20', connection: kept }),
    );
    const options = socketOptions(recorded, 0);
    expect(options).toMatchObject({ host: '192.0.2.20', port: 5986, rejectUnauthorized: true });
    expect(options).not.toHaveProperty('servername');
    expect(options).not.toHaveProperty('ca');
    const certificate = certificateNaming('IP Address:192.0.2.20');
    expect(options?.checkServerIdentity?.('192.0.2.20', certificate)).toBeUndefined();
    kept.release();
  });
});
