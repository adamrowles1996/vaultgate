import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import type { IncomingHttpHeaders } from 'node:http';

export type PinnedMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * One outbound request whose TCP connection is pinned to an address the
 * caller has already validated (OAUTH-8, ACT-55, T6). The URL's host name
 * still names the TLS server (SNI, certificate check) and the `Host`
 * header; only the socket address is fixed, so no second DNS resolution can
 * redirect the connection to a different address. The scheme picks the
 * transport: `https:` verifies the certificate against the system store with
 * no insecure option (ACT-57); `http:` is plain `node:http` to the pinned
 * address, which only an `internal` action target may name.
 */
export interface PinnedRequest {
  readonly url: string;
  readonly address: string;
  readonly method: PinnedMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer | string | undefined;
  /**
  Aborting it fails the request, and any body read still in progress, with an `AbortError`.
  */
  readonly signal: AbortSignal;
}

export type PinnedFetch = (request: PinnedRequest) => Promise<Response>;

/**
The part of `http.IncomingMessage` the transport reads.
*/
export interface ResponseMessage extends Readable {
  readonly statusCode?: number | undefined;
  readonly headers: IncomingHttpHeaders;
}

interface InFlight {
  once(event: 'error', listener: (error: Error) => void): unknown;
  end(body?: Buffer | string): unknown;
}

/**
`https.request` or `http.request`, injected so the transport is tested without a socket.
*/
export type RequestFunction = (
  url: string,
  options: RequestOptions,
  callback: (message: ResponseMessage) => void,
) => InFlight;

/**
One request function per scheme.
*/
export interface RequestFunctions {
  readonly https: RequestFunction;
  readonly http: RequestFunction;
}

/**
Statuses whose response carries no body (Fetch: "null body status").
*/
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * A `lookup` that answers with the pinned address whatever the host name.
 * Node asks for one address, or for all of them when it auto-selects the
 * family; both shapes are served.
 */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (entry !== undefined) {
        headers.append(name, entry);
      }
    }
  }
  return headers;
}

function toResponse(message: ResponseMessage): Response {
  const status = message.statusCode ?? 0;
  const headers = toHeaders(message.headers);
  if (NULL_BODY_STATUSES.has(status)) {
    message.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(message), { status, headers });
}

/**
 * The production transport behind the SSRF-safe CIMD fetcher and the `http`
 * connector: `node:https` (or `node:http` for a plain URL) with the
 * connection pinned to `request.address`. Redirects are never followed
 * here; the caller decides what a redirect means.
 */
export function createPinnedHttpsFetch(requests: Partial<RequestFunctions> = {}): PinnedFetch {
  const functions: RequestFunctions = { https: httpsRequest, http: httpRequest, ...requests };
  return (pinned) =>
    new Promise((resolve, reject) => {
      const request = new URL(pinned.url).protocol === 'http:' ? functions.http : functions.https;
      const inFlight = request(
        pinned.url,
        {
          method: pinned.method,
          headers: pinned.headers,
          lookup: pinnedLookup(pinned.address),
          signal: pinned.signal,
        },
        (message) => {
          try {
            resolve(toResponse(message));
          } catch (error: unknown) {
            reject(new Error('the response could not be read', { cause: error }));
          }
        },
      );
      inFlight.once('error', reject);
      inFlight.end(pinned.body);
    });
}

/**
 * Reads at most `limit` bytes of a response body and cancels the rest, so a
 * destination cannot make the caller buffer more than it asked for (ACT-52:
 * the caller passes its cap plus the guard band). A body of exactly `limit`
 * bytes may be cancelled after its last chunk, which costs nothing.
 */
export async function readBodyCapped(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  // Node types the body stream as `ReadableStream<any>`; Fetch guarantees bytes.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < limit) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks);
    }
    chunks.push(value);
    received += value.byteLength;
  }
  await reader.cancel();
  return Buffer.concat(chunks).subarray(0, limit);
}
