import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import type { IncomingHttpHeaders } from 'node:http';

/**
 * One outbound request whose TCP connection is pinned to an address the
 * caller has already validated (OAUTH-8, T6). The URL's host name still
 * names the TLS server (SNI, certificate check) and the `Host` header; only
 * the socket address is fixed, so no second DNS resolution can redirect the
 * connection to a different address.
 */
export interface PinnedRequest {
  readonly url: string;
  readonly address: string;
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
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
  end(): unknown;
}

/**
`https.request`, injected so the transport is tested without a socket.
*/
export type RequestFunction = (
  url: string,
  options: RequestOptions,
  callback: (message: ResponseMessage) => void,
) => InFlight;

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
 * The production transport behind the SSRF-safe fetcher: `node:https` with
 * the connection pinned to `request.address`. Redirects are never followed
 * here; the caller re-validates and re-pins every hop.
 */
export function createPinnedHttpsFetch(request: RequestFunction = httpsRequest): PinnedFetch {
  return (pinned) =>
    new Promise((resolve, reject) => {
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
      inFlight.end();
    });
}
