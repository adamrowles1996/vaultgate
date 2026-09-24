import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

import { agentFor, type ConnectionPlan, type KeptConnection } from './kept-connection.ts';

import type { CertificateCheck, TlsConnect } from './certificate-pin.ts';
import type { AgentOptions, IncomingHttpHeaders } from 'node:http';

export type PinnedMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * One outbound request whose TCP connection is pinned to an address the
 * caller has already validated (OAUTH-8, ACT-55, T6). The URL's host name
 * still names the TLS server (SNI, certificate check) and the `Host`
 * header; only the socket address is fixed, so no second DNS resolution can
 * redirect the connection to a different address. The scheme picks the
 * transport: `https:` verifies the certificate against the system store, or
 * against the caller's `certificate` pin where the destination has one, with
 * no insecure option either way (ACT-57); `http:` is plain `node:http` to the
 * pinned address, which only an `internal` action target may name.
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
  /**
  ACT-57: judges the leaf certificate in place of the system store; nothing is sent until it passes.
  */
  readonly certificate?: CertificateCheck | undefined;
  /**
   * The socket every request of one authenticated session travels, for a
   * protocol that authenticates the connection rather than the message
   * (`winrm` over NTLM). Without one each request is free to open its own.
   */
  readonly connection?: KeptConnection | undefined;
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
One request function per scheme, and the TLS connector a pinned certificate needs.
*/
export interface RequestFunctions {
  readonly https: RequestFunction;
  readonly http: RequestFunction;
  readonly connect: TlsConnect;
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

const HTTPS_PORT = 443;
const HTTP_PORT = 80;

/**
One socket, reused for every request of the session that holds it.
*/
const KEPT: AgentOptions = { keepAlive: true, maxSockets: 1 };

function connectionPlan(pinned: PinnedRequest, url: URL): ConnectionPlan {
  const isTls = url.protocol !== 'http:';
  return {
    address: pinned.address,
    port: url.port === '' ? (isTls ? HTTPS_PORT : HTTP_PORT) : Number(url.port),
    servername: url.hostname,
    isTls,
    check: pinned.certificate,
  };
}

/**
 * The agent the request runs on: the session's own socket where it holds one,
 * an agent carrying the certificate pin where the destination has one
 * (ACT-57), and otherwise nothing, which leaves Node's default agent and the
 * system trust store in charge.
 */
function agentOptions(connect: TlsConnect, pinned: PinnedRequest, url: URL): RequestOptions {
  if (pinned.connection !== undefined) {
    return {
      agent: pinned.connection.use(() => agentFor(connect, connectionPlan(pinned, url), KEPT)),
    };
  }
  return pinned.certificate === undefined
    ? {}
    : { agent: agentFor(connect, connectionPlan(pinned, url), {}) };
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
  const functions: RequestFunctions = {
    https: httpsRequest,
    http: httpRequest,
    connect: tlsConnect,
    ...requests,
  };
  return (pinned) =>
    new Promise((resolve, reject) => {
      const url = new URL(pinned.url);
      const request = url.protocol === 'http:' ? functions.http : functions.https;
      const inFlight = request(
        pinned.url,
        {
          method: pinned.method,
          headers: pinned.headers,
          lookup: pinnedLookup(pinned.address),
          signal: pinned.signal,
          ...agentOptions(functions.connect, pinned, url),
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
