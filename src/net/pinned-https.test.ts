import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { fakeTlsSocket } from '../test-support/fake-tls-socket.ts';

import {
  createPinnedHttpsFetch,
  type PinnedRequest,
  readBodyCapped,
  type RequestFunction,
  type ResponseMessage,
} from './pinned-https.ts';

import type { TlsConnect } from './certificate-pin.ts';
import type { IncomingHttpHeaders } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { ConnectionOptions } from 'node:tls';

/**
Node's `createConnection` callback, which the pinned connection never uses: it answers at once.
*/
function ignoreCallback(): void {
  // The socket is returned synchronously.
}

/**
A certificate check that is happy with anything; `certificate-pin.test.ts` proves the pin itself.
*/
function accepts(): undefined {
  // Nothing to refuse.
}

const PUBLIC = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';

function message(
  chunks: readonly string[],
  statusCode: number | undefined,
  headers: IncomingHttpHeaders = {},
): ResponseMessage {
  const bytes = chunks.map((chunk) => Buffer.from(chunk, 'utf8'));
  return Object.assign(Readable.from(bytes, { objectMode: false }), { statusCode, headers });
}

interface LookupAnswer {
  readonly single: unknown[];
  readonly all: unknown[];
}

/**
Calls the request's `lookup` both ways Node does and records what it answered.
*/
function askLookup(options: RequestOptions, hostname: string): LookupAnswer {
  const answer: LookupAnswer = { single: [], all: [] };
  options.lookup?.(hostname, {}, (...single) => {
    answer.single.push(...single);
  });
  options.lookup?.(hostname, { all: true }, (...all) => {
    answer.all.push(...all);
  });
  return answer;
}

interface Recorded {
  readonly url: string;
  readonly options: RequestOptions;
  readonly lookup: LookupAnswer;
  readonly ended: boolean;
  readonly body: Buffer | string | undefined;
}

function answering(reply: () => ResponseMessage | Error): {
  request: RequestFunction;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const request: RequestFunction = (url, options, callback) => {
    const listeners: ((error: Error) => void)[] = [];
    const call = {
      url,
      options,
      lookup: askLookup(options, new URL(url).hostname),
      ended: false,
      body: undefined,
    };
    calls.push(call);
    return {
      once: (_event, listener) => {
        listeners.push(listener);
      },
      end: (body) => {
        calls[calls.length - 1] = { ...call, ended: true, body };
        const outcome = reply();
        if (outcome instanceof Error) {
          for (const listener of listeners) {
            listener(outcome);
          }
        } else {
          callback(outcome);
        }
      },
    };
  };
  return { request, calls };
}

function pinned(overrides: Partial<PinnedRequest> = {}): PinnedRequest {
  return {
    url: 'https://agent.example.com/client.json',
    address: PUBLIC,
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
    ...overrides,
  };
}

describe('createPinnedHttpsFetch', () => {
  it('OAUTH-8 connects to the pinned address, keeping the host name for TLS and Host', async () => {
    const { request, calls } = answering(() =>
      message(['{"a":', '1}'], 200, { 'content-type': 'application/json' }),
    );
    const response = await createPinnedHttpsFetch({ https: request })(pinned());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"a":1}');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://agent.example.com/client.json');
    expect(call?.ended).toBe(true);
    expect(call?.options).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } });
    expect(call?.body).toBeUndefined();
    expect(call?.options.signal).toBeInstanceOf(AbortSignal);
    expect(call?.lookup).toStrictEqual({
      single: [null, PUBLIC, 4],
      all: [null, [{ address: PUBLIC, family: 4 }]],
    });
    // ACT-57: with no pin the system store verifies, so the transport opens no socket of its own.
    expect(call?.options.createConnection).toBeUndefined();
    expect(call?.options.agent).toBeUndefined();
  });

  it('OAUTH-8 pins an IPv6 address with its family', async () => {
    const { request, calls } = answering(() => message([], 200));
    await createPinnedHttpsFetch({ https: request })(pinned({ address: PUBLIC_V6 }));
    expect(calls[0]?.lookup).toStrictEqual({
      single: [null, PUBLIC_V6, 6],
      all: [null, [{ address: PUBLIC_V6, family: 6 }]],
    });
  });

  it('OAUTH-8 exposes every header, including repeated ones', async () => {
    const headers = { location: '/next', 'set-cookie': ['a=1', 'b=2'], 'x-none': undefined };
    const { request } = answering(() => message([], 302, headers));
    const response = await createPinnedHttpsFetch({ https: request })(pinned());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/next');
    expect(response.headers.getSetCookie()).toStrictEqual(['a=1', 'b=2']);
    expect(response.headers.has('x-none')).toBe(false);
  });

  it('OAUTH-8 drains a null-body status instead of attaching a body', async () => {
    const source = message(['ignored'], 204);
    const resume = vi.spyOn(source, 'resume');
    const { request } = answering(() => source);
    const response = await createPinnedHttpsFetch({ https: request })(pinned());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('OAUTH-8 rejects on a transport error or an unusable status', async () => {
    const failing = answering(() => new Error('ECONNRESET'));
    await expect(createPinnedHttpsFetch({ https: failing.request })(pinned())).rejects.toThrow(
      'ECONNRESET',
    );
    const noStatus = answering(() => message([], undefined));
    await expect(createPinnedHttpsFetch({ https: noStatus.request })(pinned())).rejects.toThrow(
      'the response could not be read',
    );
  });

  it('OAUTH-8 defaults to node:https', () => {
    expect(typeof createPinnedHttpsFetch()).toBe('function');
  });

  it('ACT-55 ACT-57 gives a pinned destination its own TLS connection, on the URL port and host', async () => {
    const opened: ConnectionOptions[] = [];
    const connect: TlsConnect = (options) => {
      opened.push(options);
      return fakeTlsSocket();
    };
    for (const url of ['https://win.example.com:5986/wsman', 'https://agent.example.com/c.json']) {
      const { request, calls } = answering(() => message([], 200));
      await createPinnedHttpsFetch({ https: request, connect })(
        pinned({ url, certificate: accepts }),
      );
      expect(calls[0]?.options.agent).toBe(false);
      calls[0]?.options.createConnection?.({}, ignoreCallback);
    }
    expect(opened).toStrictEqual([
      { host: PUBLIC, port: 5986, servername: 'win.example.com', rejectUnauthorized: false },
      { host: PUBLIC, port: 443, servername: 'agent.example.com', rejectUnauthorized: false },
    ]);
  });

  it('ACT-80 sends any method with a body, pinned the same way', async () => {
    const { request, calls } = answering(() => message(['{"id":1}'], 201));
    const body = Buffer.from('{"name":"x"}', 'utf8');
    const response = await createPinnedHttpsFetch({ https: request })(
      pinned({
        url: 'https://api.example.com/v1/items',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect(calls[0]).toMatchObject({
      url: 'https://api.example.com/v1/items',
      options: { method: 'POST', headers: { 'content-type': 'application/json' } },
      body,
      lookup: { single: [null, PUBLIC, 4] },
    });
  });

  it('ACT-55 ACT-57 uses node:http for a plain URL and node:https for everything else', async () => {
    const plain = answering(() => message(['plain'], 200));
    const secure = answering(() => message(['secure'], 200));
    const fetch = createPinnedHttpsFetch({ https: secure.request, http: plain.request });
    const overPlain = await fetch(
      pinned({ url: 'http://intranet.example/api', address: '10.0.0.8' }),
    );
    expect(await overPlain.text()).toBe('plain');
    expect(plain.calls.map((call) => call.url)).toStrictEqual(['http://intranet.example/api']);
    expect(plain.calls[0]?.lookup.single).toStrictEqual([null, '10.0.0.8', 4]);
    expect(secure.calls).toStrictEqual([]);
    const overTls = await fetch(pinned());
    expect(await overTls.text()).toBe('secure');
    expect(plain.calls).toHaveLength(1);
    expect(secure.calls).toHaveLength(1);
  });
});

function streamed(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }),
  );
}

describe('readBodyCapped', () => {
  it('ACT-52 returns a whole body under the limit and nothing for a null body', async () => {
    const whole = await readBodyCapped(streamed(['ab', 'cd']), 10);
    expect(whole.toString('utf8')).toBe('abcd');
    const none = await readBodyCapped(new Response(null, { status: 204 }), 10);
    expect(none.length).toBe(0);
  });

  it('ACT-52 stops reading at the limit, cuts the last chunk and cancels the rest', async () => {
    let isCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('0123456789'));
      },
      cancel() {
        isCancelled = true;
      },
    });
    const read = await readBodyCapped(new Response(body), 25);
    expect(read.toString('utf8')).toBe('0123456789012345678901234');
    expect(isCancelled).toBe(true);
  });
});
