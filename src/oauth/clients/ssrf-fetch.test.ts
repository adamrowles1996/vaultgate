import { describe, expect, it, vi } from 'vitest';

import { unwrapFail, unwrapOk } from '../../test-support/result.ts';

import {
  type FetchLike,
  type Lookup,
  safeFetch,
  type SafeFetchOptions,
  type SafeFetchResult,
} from './ssrf-fetch.ts';

const PUBLIC = '93.184.216.34';
const PUBLIC_B = '198.41.0.4';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';
const PRIVATE = '10.0.0.5';
const URL_A = 'https://a.example/1';

const resolvesPublic: Lookup = () => Promise.resolve([PUBLIC]);
const resolvesPublicAndPrivate: Lookup = () => Promise.resolve([PUBLIC, '10.0.0.5']);
const resolvesNothing: Lookup = () => Promise.resolve([]);
const lookupThrows: Lookup = () => Promise.reject(new Error('ENOTFOUND'));
const privateUnlessA: Lookup = (host) =>
  Promise.resolve([host === 'a.example' ? PUBLIC : '192.168.0.1']);

function options(overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    lookup: resolvesPublic,
    timeoutMs: 4000,
    maxRedirects: 2,
    maxBodyBytes: 1024,
    ...overrides,
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function answering(response: () => Response): FetchLike {
  return () => Promise.resolve(response());
}

function failing(reason: unknown): FetchLike {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercises the non-Error rejection path too
  return () => Promise.reject(reason);
}

async function failureOf(url: string, overrides: Partial<SafeFetchOptions>): Promise<string> {
  const result = await safeFetch(url, options(overrides));
  return unwrapFail(result).message;
}

async function successOf(
  url: string,
  overrides: Partial<SafeFetchOptions>,
): Promise<SafeFetchResult> {
  const result = await safeFetch(url, options(overrides));
  return unwrapOk(result);
}

describe('safeFetch', () => {
  it('OAUTH-8 fetches with Accept: application/json, a timeout and the checked address', async () => {
    const fetch = vi.fn<FetchLike>(answering(() => new Response('body', { status: 200 })));
    const result = await successOf('https://agent.example.com/c.json', { fetch });
    expect(result.status).toBe(200);
    expect(result.body).toBe('body');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [request] = fetch.mock.calls[0]!;
    expect(request).toMatchObject({
      url: 'https://agent.example.com/c.json',
      address: PUBLIC,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('T6 pins the connection to the validated address: the first resolved one, or the literal', async () => {
    const addresses: string[] = [];
    const fetch: FetchLike = ({ address }) => {
      addresses.push(address);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const lookup: Lookup = () => Promise.resolve([PUBLIC_B, PUBLIC]);
    await successOf('https://agent.example.com/c.json', { fetch, lookup });
    await successOf(`https://${PUBLIC}/c.json`, { fetch, lookup });
    await successOf(`https://[${PUBLIC_V6}]/c.json`, { fetch, lookup });
    expect(addresses).toStrictEqual([PUBLIC_B, PUBLIC, PUBLIC_V6]);
  });

  it('T6 never resolves twice: a name that turns private after the check cannot move the connection', async () => {
    const answers = [[PUBLIC], [PRIVATE]];
    const lookup = vi.fn<Lookup>(() => Promise.resolve(answers.shift() ?? [PRIVATE]));
    const fetch = vi.fn<FetchLike>(answering(() => new Response('{}', { status: 200 })));
    const result = await successOf('https://agent.example.com/c.json', { fetch, lookup });
    expect(result.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0].address).toBe(PUBLIC);
    expect(answers).toStrictEqual([[PRIVATE]]);
  });

  it('OAUTH-8 rejects non-https URLs before any lookup', async () => {
    const lookup = vi.fn<Lookup>();
    expect(await failureOf('http://agent.example.com/c.json', { lookup })).toBe(
      '"http://agent.example.com/c.json" is not an https URL',
    );
    expect(await failureOf('nope', { lookup })).toContain('not an https URL');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('T6 rejects a host that resolves to a private address', async () => {
    const fetch = vi.fn<FetchLike>();
    const lookup = resolvesPublicAndPrivate;
    expect(await failureOf('https://agent.example.com/c.json', { fetch, lookup })).toBe(
      'host "agent.example.com" does not resolve to a public address',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('T6 rejects a host that does not resolve or whose lookup throws', async () => {
    expect(await failureOf('https://a.example/', { lookup: resolvesNothing })).toContain(
      'does not resolve',
    );
    expect(await failureOf('https://a.example/', { lookup: lookupThrows })).toContain(
      'does not resolve',
    );
  });

  it('T6 rejects a private IP literal and accepts a public one, never consulting DNS', async () => {
    const lookup = vi.fn<Lookup>();
    expect(await failureOf('https://127.0.0.1/c.json', { lookup })).toContain('does not resolve');
    expect(await failureOf('https://[::1]/c.json', { lookup })).toContain('does not resolve');
    const result = await successOf(`https://${PUBLIC}/c.json`, { lookup });
    expect(result.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('OAUTH-8 follows at most two redirects, re-validating each hop', async () => {
    const lookup = vi.fn<Lookup>(resolvesPublic);
    const hops = new Map<string, Response>([
      [URL_A, redirect('/2')],
      ['https://a.example/2', redirect('https://b.example/3')],
    ]);
    const addresses: string[] = [];
    const fetch: FetchLike = ({ url, address }) => {
      addresses.push(address);
      return Promise.resolve(hops.get(url) ?? new Response('final', { status: 200 }));
    };
    const result = await successOf(URL_A, { fetch, lookup });
    expect(result.body).toBe('final');
    expect(lookup.mock.calls.map(([host]) => host)).toStrictEqual([
      'a.example',
      'a.example',
      'b.example',
    ]);
    expect(addresses).toStrictEqual([PUBLIC, PUBLIC, PUBLIC]);
  });

  it('OAUTH-8 stops after the redirect cap', async () => {
    const fetch = vi.fn<FetchLike>(answering(() => redirect('https://a.example/again')));
    expect(await failureOf(URL_A, { fetch })).toBe('more than 2 redirects');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('OAUTH-8 rejects a redirect to a non-https or missing location', async () => {
    const plain = answering(() => redirect('http://a.example/2'));
    const missing = answering(() => new Response(null, { status: 301 }));
    expect(await failureOf(URL_A, { fetch: plain })).toBe('redirect target is not an https URL');
    expect(await failureOf(URL_A, { fetch: missing })).toBe('redirect target is not an https URL');
  });

  it('T6 rejects a redirect to a private host', async () => {
    const lookup = privateUnlessA;
    const fetch = vi.fn<FetchLike>(({ url }) =>
      Promise.resolve(url === URL_A ? redirect('https://internal.example/') : new Response('x')),
    );
    expect(await failureOf(URL_A, { fetch, lookup })).toContain('internal.example');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('OAUTH-8 caps the body size', async () => {
    const fetch = answering(() => new Response('x'.repeat(2000), { status: 200 }));
    expect(await failureOf('https://a.example/', { fetch })).toBe('response exceeds 1024 bytes');
  });

  it('OAUTH-8 treats an empty body as empty text', async () => {
    const fetch = answering(() => new Response(null, { status: 204 }));
    const result = await successOf('https://a.example/', { fetch });
    expect(result.body).toBe('');
  });

  it('OAUTH-8 wraps a network failure', async () => {
    const typed = failing(new TypeError('fetch failed'));
    const untyped = failing('string reason');
    expect(await failureOf('https://a.example/', { fetch: typed })).toBe(
      'fetch failed: fetch failed',
    );
    expect(await failureOf('https://a.example/', { fetch: untyped })).toBe('fetch failed: unknown');
  });

  it('OAUTH-8 wraps an unexpected throw from the body stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream broke');
      },
    });
    const fetch = answering(() => new Response(stream, { status: 200 }));
    expect(await failureOf('https://a.example/', { fetch })).toBe('Error: stream broke');
  });
});
