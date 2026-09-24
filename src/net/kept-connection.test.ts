import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { fakeTlsSocket } from '../test-support/fake-tls-socket.ts';

import { agentFor, KeptConnection, type ConnectionPlan } from './kept-connection.ts';
import { createPinnedHttpsFetch, type RequestFunction } from './pinned-https.ts';

import type { TlsConnect } from './certificate-pin.ts';
import type { ConnectionOptions } from 'node:tls';

const PUBLIC = '93.184.216.34';

/**
A certificate check that is happy with anything; `certificate-pin.test.ts` proves the pin itself.
*/
function accepts(): undefined {
  // Nothing to refuse.
}

function plan(overrides: Partial<ConnectionPlan> = {}): ConnectionPlan {
  return {
    address: PUBLIC,
    port: 5986,
    servername: 'win.example.com',
    isTls: true,
    guard: { check: undefined, record: recorded.push.bind(recorded) },
    ...overrides,
  };
}

const recorded: Buffer[] = [];

describe('agentFor', () => {
  it('ACT-55 uses a plain agent for a plain endpoint and a TLS one otherwise', () => {
    expect(agentFor(fakeConnect().connect, plan({ isTls: false }), {})).toBeInstanceOf(HttpAgent);
    expect(agentFor(fakeConnect().connect, plan(), {})).toBeInstanceOf(HttpsAgent);
  });

  it('ACT-57 opens the pinned socket itself, on the validated address and the URL host name', () => {
    const { connect, opened } = fakeConnect();
    const agent = agentFor(connect, plan({ guard: { check: accepts, record: undefined } }), {});
    expect(agent.createConnection({})).toBeDefined();
    expect(opened).toStrictEqual([
      { host: PUBLIC, port: 5986, servername: 'win.example.com', rejectUnauthorized: false },
    ]);
  });

  it('ACT-89 keeps one socket when the caller asks it to', () => {
    const agent = agentFor(fakeConnect().connect, plan({ isTls: false }), {
      keepAlive: true,
      maxSockets: 1,
    });
    expect(agent.maxSockets).toBe(1);
    agent.destroy();
  });
});

describe('KeptConnection', () => {
  it('ACT-89 makes its agent once and hands the same one back', () => {
    const kept = new KeptConnection();
    let made = 0;
    const make = (): HttpAgent => {
      made += 1;
      return new HttpAgent();
    };
    const first = kept.use(make);
    expect(kept.use(make)).toBe(first);
    expect(made).toBe(1);
    kept.release();
  });

  it('ACT-89 releases the socket, and releasing one it never made is harmless', () => {
    const kept = new KeptConnection();
    kept.release();
    const agent = kept.use(() => new HttpAgent({ keepAlive: true }));
    kept.release();
    expect(kept.use(() => new HttpAgent())).not.toBe(agent);
    kept.release();
  });

  it('ACT-89 leaves the leaf certificate of a kept TLS connection where an exchange can bind to it', async () => {
    const kept = new KeptConnection();
    const leaf = Buffer.from('canary-leaf-certificate-der', 'utf8');
    const socket = fakeTlsSocket(leaf);
    await createPinnedHttpsFetch({ https: answering, connect: () => socket })({
      url: 'https://win.example.com:5986/wsman',
      address: PUBLIC,
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(4000),
      connection: kept,
    });
    expect(kept.certificate).toBeUndefined();
    // Node asks the agent for a socket when it needs one; the fake completes
    // its handshake here, which is the moment a peer presents a certificate.
    kept.use(() => new HttpAgent()).createConnection({});
    socket.handshake();
    expect(kept.certificate).toStrictEqual(leaf);
    kept.release();
  });

  it('ACT-89 remembers the leaf certificate its socket saw and forgets it on release', () => {
    const leaf = Buffer.from('canary-leaf-certificate-der', 'utf8');
    const kept = new KeptConnection();
    expect(kept.certificate).toBeUndefined();
    kept.record(leaf);
    expect(kept.certificate).toBe(leaf);
    kept.release();
    expect(kept.certificate).toBeUndefined();
  });
});

function ignore(): void {
  // The request is finished with as soon as the agent has been chosen.
}

/**
A request function that answers every call with an empty 200, so the agent is all that matters.
*/
const answering: RequestFunction = (_url, _options, callback) => {
  callback(Object.assign(Readable.from([]), { statusCode: 200, headers: {} }));
  return { once: ignore, end: ignore };
};

function fakeConnect(): { connect: TlsConnect; opened: ConnectionOptions[] } {
  const opened: ConnectionOptions[] = [];
  return {
    opened,
    connect: (options) => {
      opened.push(options);
      return fakeTlsSocket();
    },
  };
}
