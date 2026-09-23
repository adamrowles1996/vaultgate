import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  createPinnedHttpsFetch,
  type PinnedRequest,
  type RequestFunction,
  type ResponseMessage,
} from './pinned-https.ts';

import type { IncomingHttpHeaders } from 'node:http';
import type { RequestOptions } from 'node:https';

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
}

function answering(reply: () => ResponseMessage | Error): {
  request: RequestFunction;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const request: RequestFunction = (url, options, callback) => {
    const listeners: ((error: Error) => void)[] = [];
    const call = { url, options, lookup: askLookup(options, new URL(url).hostname), ended: false };
    calls.push(call);
    return {
      once: (_event, listener) => {
        listeners.push(listener);
      },
      end: () => {
        calls[calls.length - 1] = { ...call, ended: true };
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
    const response = await createPinnedHttpsFetch(request)(pinned());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"a":1}');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://agent.example.com/client.json');
    expect(call?.ended).toBe(true);
    expect(call?.options).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } });
    expect(call?.options.signal).toBeInstanceOf(AbortSignal);
    expect(call?.lookup).toStrictEqual({
      single: [null, PUBLIC, 4],
      all: [null, [{ address: PUBLIC, family: 4 }]],
    });
  });

  it('OAUTH-8 pins an IPv6 address with its family', async () => {
    const { request, calls } = answering(() => message([], 200));
    await createPinnedHttpsFetch(request)(pinned({ address: PUBLIC_V6 }));
    expect(calls[0]?.lookup).toStrictEqual({
      single: [null, PUBLIC_V6, 6],
      all: [null, [{ address: PUBLIC_V6, family: 6 }]],
    });
  });

  it('OAUTH-8 exposes every header, including repeated ones', async () => {
    const headers = { location: '/next', 'set-cookie': ['a=1', 'b=2'], 'x-none': undefined };
    const { request } = answering(() => message([], 302, headers));
    const response = await createPinnedHttpsFetch(request)(pinned());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/next');
    expect(response.headers.getSetCookie()).toStrictEqual(['a=1', 'b=2']);
    expect(response.headers.has('x-none')).toBe(false);
  });

  it('OAUTH-8 drains a null-body status instead of attaching a body', async () => {
    const source = message(['ignored'], 204);
    const resume = vi.spyOn(source, 'resume');
    const { request } = answering(() => source);
    const response = await createPinnedHttpsFetch(request)(pinned());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('OAUTH-8 rejects on a transport error or an unusable status', async () => {
    const failing = answering(() => new Error('ECONNRESET'));
    await expect(createPinnedHttpsFetch(failing.request)(pinned())).rejects.toThrow('ECONNRESET');
    const noStatus = answering(() => message([], undefined));
    await expect(createPinnedHttpsFetch(noStatus.request)(pinned())).rejects.toThrow(
      'the response could not be read',
    );
  });

  it('OAUTH-8 defaults to node:https', () => {
    expect(typeof createPinnedHttpsFetch()).toBe('function');
  });
});
