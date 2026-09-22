import { isIP } from 'node:net';

import { fail, ok, type Result } from '../../result.ts';
import { isPublicAddress } from '../ip-ranges.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Resolves a host name to every address it maps to. Injected (QG-2).
 */
export type Lookup = (hostname: string) => Promise<readonly string[]>;

export interface SafeFetchOptions {
  readonly fetch: FetchLike;
  readonly lookup: Lookup;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxBodyBytes: number;
}

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function parseHttpsUrl(text: string): URL | undefined {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function literalAddress(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function resolveAll(hostname: string, lookup: Lookup): Promise<readonly string[]> {
  try {
    return await lookup(hostname);
  } catch {
    return [];
  }
}

/**
 * OAUTH-8: every address a host resolves to must be public before a
 * connection is attempted. A host with no addresses is rejected too.
 */
async function assertPublicHost(url: URL, lookup: Lookup): Promise<void> {
  const literal = literalAddress(url.hostname);
  const addresses = isIP(literal) === 0 ? await resolveAll(url.hostname, lookup) : [literal];
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new SafeFetchError(`host "${url.hostname}" does not resolve to a public address`);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  await response.body.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          throw new SafeFetchError(`response exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      },
    }),
  );
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchOnce(url: URL, options: SafeFetchOptions): Promise<Response> {
  await assertPublicHost(url, options.lookup);
  try {
    return await options.fetch(url.href, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new SafeFetchError(`fetch failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

function nextLocation(response: Response, current: URL): URL {
  const location = response.headers.get('location');
  const target = location === null ? undefined : parseHttpsUrl(new URL(location, current).href);
  if (target === undefined) {
    throw new SafeFetchError('redirect target is not an https URL');
  }
  return target;
}

async function follow(url: URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
  let current = url;
  let response = await fetchOnce(current, options);
  let redirects = 0;
  while (REDIRECT_STATUSES.has(response.status)) {
    redirects += 1;
    if (redirects > options.maxRedirects) {
      throw new SafeFetchError(`more than ${options.maxRedirects} redirects`);
    }
    current = nextLocation(response, current);
    response = await fetchOnce(current, options);
  }
  const body = await readCapped(response, options.maxBodyBytes);
  return { status: response.status, headers: response.headers, body };
}

/**
 * The SSRF-safe fetcher (OAUTH-8, T6): https only, every hop DNS-checked,
 * bounded redirects, timeout and body size.
 */
export async function safeFetch(
  text: string,
  options: SafeFetchOptions,
): Promise<Result<SafeFetchResult, SafeFetchError>> {
  const url = parseHttpsUrl(text);
  if (url === undefined) {
    return fail(new SafeFetchError(`"${text}" is not an https URL`));
  }
  try {
    return ok(await follow(url, options));
  } catch (error) {
    return fail(error instanceof SafeFetchError ? error : new SafeFetchError(String(error)));
  }
}
