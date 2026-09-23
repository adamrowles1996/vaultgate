import { fail, ok, type Result } from '../../result.ts';
import { type Clock, HOUR_MS, MINUTE_MS, SECOND_MS } from '../clock.ts';
import { OAuthError } from '../errors.ts';

import { type CimdDocument, parseCimdDocument } from './cimd-document.ts';
import { type FetchLike, safeFetch } from './ssrf-fetch.ts';

import type { Lookup } from '../../net/ip-ranges.ts';
import type { RateLimiter } from '../../net/rate-limit.ts';
import type { CimdCacheRepo } from '../repositories/cimd-cache.ts';

export interface WarnLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface CimdFetcherOptions {
  readonly fetch: FetchLike;
  readonly lookup: Lookup;
  readonly now: Clock;
  readonly cache: CimdCacheRepo;
  readonly logger: WarnLogger;
  /**
  Process-wide, 30 per minute (spec §10.4).
  */
  readonly rateLimiter: RateLimiter;
}

interface FetchOptions {
  /**
  Bypasses a fresh cache entry (T22: redirect mismatch).
  */
  readonly force?: boolean;
}

export interface CimdFetcher {
  fetch(clientId: string, options?: FetchOptions): Promise<Result<CimdDocument, OAuthError>>;
}

/**
 * OAUTH-8 limits.
 */
const CIMD_TIMEOUT_MS = 4 * SECOND_MS;
const CIMD_MAX_REDIRECTS = 2;
const CIMD_MAX_BODY_BYTES = 64 * 1024;

/**
 * OAUTH-10 bounds; a document without `max-age` is kept for five minutes.
 */
const MIN_CACHE_MS = MINUTE_MS;
const MAX_CACHE_MS = 24 * HOUR_MS;
const DEFAULT_CACHE_MS = 5 * MINUTE_MS;

const MAX_AGE = /(?:^|,)\s*max-age=(\d{1,10})\s*(?:,|$)/i;

export function cacheLifetimeMs(cacheControl: string | null): number {
  const match = cacheControl === null ? null : MAX_AGE.exec(cacheControl);
  return match?.[1] === undefined
    ? DEFAULT_CACHE_MS
    : Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, Number(match[1]) * SECOND_MS));
}

function isJsonContentType(headers: Headers): boolean {
  const type = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'application/json';
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function cachedDocument(cache: CimdCacheRepo, clientId: string): CimdDocument | undefined {
  const entry = cache.find(clientId);
  if (entry === undefined) {
    return undefined;
  }
  const parsed = parseCimdDocument(clientId, entry.document);
  return parsed.ok ? parsed.document : undefined;
}

/**
 * OAUTH-10: a fetch failure falls back to any cached copy, however old.
 */
function fallback(
  options: CimdFetcherOptions,
  clientId: string,
  reason: string,
): Result<CimdDocument, OAuthError> {
  const stale = cachedDocument(options.cache, clientId);
  if (stale !== undefined) {
    options.logger.warn({ clientId, reason }, 'CIMD fetch failed; using the cached document');
    return ok(stale);
  }
  return fail(new OAuthError('invalid_client', `client metadata could not be fetched: ${reason}`));
}

export function createCimdFetcher(options: CimdFetcherOptions): CimdFetcher {
  const { cache, now, rateLimiter } = options;

  async function refetch(clientId: string): Promise<Result<CimdDocument, OAuthError>> {
    if (!rateLimiter.take('cimd').allowed) {
      return fallback(options, clientId, 'fetch rate limit reached');
    }
    const fetched = await safeFetch(clientId, {
      fetch: options.fetch,
      lookup: options.lookup,
      timeoutMs: CIMD_TIMEOUT_MS,
      maxRedirects: CIMD_MAX_REDIRECTS,
      maxBodyBytes: CIMD_MAX_BODY_BYTES,
    });
    if (!fetched.ok) {
      return fallback(options, clientId, fetched.error.message);
    }
    const response = fetched.value;
    if (response.status !== 200 || !isJsonContentType(response.headers)) {
      return fallback(
        options,
        clientId,
        `HTTP ${response.status} without an application/json body`,
      );
    }
    const parsed = parseCimdDocument(clientId, parseBody(response.body));
    if (!parsed.ok) {
      return fail(new OAuthError('invalid_client', `client metadata is invalid: ${parsed.reason}`));
    }
    const at = now();
    cache.put({
      clientId,
      document: parsed.document,
      fetchedAt: at,
      expiresAt: at + cacheLifetimeMs(response.headers.get('cache-control')),
      etag: response.headers.get('etag') ?? undefined,
    });
    return ok(parsed.document);
  }

  return {
    async fetch(clientId, { force = false } = {}) {
      const entry = force ? undefined : cache.find(clientId);
      const fresh =
        entry !== undefined && entry.expiresAt > now()
          ? cachedDocument(cache, clientId)
          : undefined;
      return fresh === undefined ? refetch(clientId) : ok(fresh);
    },
  };
}
