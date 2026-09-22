import { describe, expect, it, vi } from 'vitest';

import { openTestRepos } from '../../test-support/oauth-store.ts';
import { unwrapFail, unwrapOk } from '../../test-support/result.ts';

import { cacheLifetimeMs, type CimdFetcherOptions, createCimdFetcher } from './cimd.ts';

import type { FetchLike } from './ssrf-fetch.ts';

const CLIENT_ID = 'https://agent.example.com/client.json';
const PUBLIC = '93.184.216.34';

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function validDocument(name = 'Agent'): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: name,
    redirect_uris: ['https://agent.example.com/cb'],
  };
}

function serving(response: () => Response): FetchLike {
  return () => Promise.resolve(response());
}

function servingDocument(headers: Record<string, string> = {}): FetchLike {
  return serving(() => jsonResponse(validDocument(), headers));
}

function rawResponse(body: string, status: number, contentType?: string): FetchLike {
  const headers = contentType === undefined ? {} : { 'content-type': contentType };
  return serving(() => new Response(body, { status, headers }));
}

interface Harness {
  readonly fetcher: ReturnType<typeof createCimdFetcher>;
  readonly fetch: ReturnType<typeof vi.fn<FetchLike>>;
  readonly warnings: () => readonly unknown[];
  readonly repos: ReturnType<typeof openTestRepos>;
  tick: (ms: number) => void;
}

function harness(
  fetchImplementation: FetchLike,
  overrides: Partial<CimdFetcherOptions> = {},
): Harness {
  let at = 1_000_000;
  const fetch = vi.fn<FetchLike>(fetchImplementation);
  const warnings: unknown[] = [];
  const repos = openTestRepos();
  const fetcher = createCimdFetcher({
    fetch,
    lookup: () => Promise.resolve([PUBLIC]),
    now: () => at,
    cache: repos.cimdCache,
    logger: {
      warn: (fields, message) => {
        warnings.push({ ...fields, message });
      },
    },
    rateLimiter: { take: () => ({ allowed: true }) },
    ...overrides,
  });
  return {
    fetcher,
    fetch,
    warnings: () => warnings,
    repos,
    tick: (ms) => {
      at += ms;
    },
  };
}

async function nameOf(h: Harness): Promise<unknown> {
  const result = await h.fetcher.fetch(CLIENT_ID);
  return unwrapOk(result).client_name;
}

async function failureOf(h: Harness): Promise<string> {
  const result = await h.fetcher.fetch(CLIENT_ID);
  return unwrapFail(result).description;
}

describe('cacheLifetimeMs', () => {
  it('OAUTH-10 honours max-age clamped to [60 s, 24 h] and defaults to five minutes', () => {
    expect(cacheLifetimeMs(null)).toBe(300_000);
    expect(cacheLifetimeMs('public')).toBe(300_000);
    expect(cacheLifetimeMs('max-age=10')).toBe(60_000);
    expect(cacheLifetimeMs('public, max-age=600')).toBe(600_000);
    expect(cacheLifetimeMs('MAX-AGE=999999999')).toBe(86_400_000);
  });
});

describe('createCimdFetcher', () => {
  it('OAUTH-9 fetches, validates and caches a document', async () => {
    const h = harness(servingDocument({ 'cache-control': 'max-age=120', etag: '"v1"' }));
    const document = unwrapOk(await h.fetcher.fetch(CLIENT_ID));
    expect(document.client_name).toBe('Agent');
    expect(h.repos.cimdCache.find(CLIENT_ID)).toStrictEqual({
      clientId: CLIENT_ID,
      document: validDocument(),
      fetchedAt: 1_000_000,
      expiresAt: 1_120_000,
      etag: '"v1"',
    });
  });

  it('OAUTH-10 serves a fresh cache entry without fetching, and refetches once it expires', async () => {
    const h = harness(servingDocument());
    await h.fetcher.fetch(CLIENT_ID);
    await h.fetcher.fetch(CLIENT_ID);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.tick(300_000);
    await h.fetcher.fetch(CLIENT_ID);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.repos.cimdCache.find(CLIENT_ID)?.etag).toBeUndefined();
  });

  it('T22 refetches when forced even while the cache is fresh', async () => {
    const h = harness(servingDocument());
    await h.fetcher.fetch(CLIENT_ID);
    await h.fetcher.fetch(CLIENT_ID, { force: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('OAUTH-10 uses the cached copy and warns when a refetch fails', async () => {
    let isHealthy = true;
    const healthyFetch = servingDocument();
    const h = harness((url, init) =>
      isHealthy ? healthyFetch(url, init) : Promise.reject(new TypeError('down')),
    );
    await h.fetcher.fetch(CLIENT_ID);
    isHealthy = false;
    h.tick(600_000);
    expect(await nameOf(h)).toBe('Agent');
    expect(h.warnings()).toStrictEqual([
      {
        clientId: CLIENT_ID,
        reason: 'fetch failed: down',
        message: 'CIMD fetch failed; using the cached document',
      },
    ]);
  });

  it('OAUTH-10 fails with invalid_client when a fetch fails and nothing is cached', async () => {
    const h = harness(() => Promise.reject(new TypeError('down')));
    const result = await h.fetcher.fetch(CLIENT_ID);
    const error = unwrapFail(result);
    expect(error.code).toBe('invalid_client');
    expect(error.description).toBe('client metadata could not be fetched: fetch failed: down');
  });

  it('OAUTH-8 treats a non-200 or non-JSON answer as a fetch failure', async () => {
    const notFound = await failureOf(harness(rawResponse('nope', 404, 'application/json')));
    expect(notFound).toContain('HTTP 404');
    const html = await failureOf(harness(rawResponse('<html>', 200, 'text/html')));
    expect(html).toContain('HTTP 200 without an application/json body');
    const untyped = await failureOf(harness(rawResponse('{}', 200)));
    expect(untyped).toContain('without an application/json body');
  });

  it('OAUTH-9 rejects an invalid document without falling back to the cache', async () => {
    let name = 'Agent';
    const h = harness(serving(() => jsonResponse(validDocument(name))));
    await h.fetcher.fetch(CLIENT_ID);
    name = '';
    h.tick(600_000);
    const result = await h.fetcher.fetch(CLIENT_ID);
    const error = unwrapFail(result);
    expect(error.code).toBe('invalid_client');
    expect(error.description).toContain('client metadata is invalid: client_name');
    const garbage = await failureOf(harness(rawResponse('not json', 200, 'application/json')));
    expect(garbage).toContain('client metadata is invalid');
  });

  it('§10.4 falls back to the cache when the process-wide fetch limit is reached', async () => {
    let isAllowed = true;
    const h = harness(servingDocument(), {
      rateLimiter: {
        take: () => (isAllowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 1 }),
      },
    });
    await h.fetcher.fetch(CLIENT_ID);
    isAllowed = false;
    h.tick(600_000);
    expect(await nameOf(h)).toBe('Agent');
    expect(h.warnings()[0]).toMatchObject({ reason: 'fetch rate limit reached' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('OAUTH-10 ignores a cached document that no longer validates', async () => {
    const h = harness(servingDocument());
    h.repos.cimdCache.put({
      clientId: CLIENT_ID,
      document: { client_id: 'other' },
      fetchedAt: 0,
      expiresAt: 9_999_999,
      etag: undefined,
    });
    expect(await nameOf(h)).toBe('Agent');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
