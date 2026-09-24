import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { describe, expect, it } from 'vitest';

import { fakeTlsSocket } from '../test-support/fake-tls-socket.ts';

import { agentFor, KeptConnection, type ConnectionPlan } from './kept-connection.ts';

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
    check: undefined,
    ...overrides,
  };
}

describe('agentFor', () => {
  it('ACT-55 uses a plain agent for a plain endpoint and a TLS one otherwise', () => {
    expect(agentFor(fakeConnect().connect, plan({ isTls: false }), {})).toBeInstanceOf(HttpAgent);
    expect(agentFor(fakeConnect().connect, plan(), {})).toBeInstanceOf(HttpsAgent);
  });

  it('ACT-57 opens the pinned socket itself, on the validated address and the URL host name', () => {
    const { connect, opened } = fakeConnect();
    const agent = agentFor(connect, plan({ check: accepts }), {});
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
});

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
