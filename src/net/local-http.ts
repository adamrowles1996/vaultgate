/**
 * HTTP to a sidecar vaultgate runs beside it (ACT-113): over a Unix domain
 * socket (`unix:/run/…/sidecar.sock`) or to an internal `http://` address,
 * never across the internet, which the configuration schema already refuses.
 * A request body may be a stream (the `code` archive, ACT-105), which is
 * written as it arrives; the response body is read up to a cap and no
 * further, so a misbehaving sidecar cannot make vaultgate buffer without end.
 */
import { request as httpRequest, type RequestOptions } from 'node:http';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type LocalMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

export interface LocalRequest {
  readonly method: LocalMethod;
  /**
  The path and query, starting with `/`.
  */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
  /**
  The largest response body read; a longer one fails the request.
  */
  readonly maxResponseBytes: number;
}

export interface LocalResponse {
  readonly status: number;
  readonly body: Buffer;
}

export type LocalHttp = (request: LocalRequest) => Promise<LocalResponse>;

/**
The part of `http.IncomingMessage` the client reads.
*/
export interface LocalMessage extends AsyncIterable<unknown> {
  readonly statusCode?: number | undefined;
  destroy(): unknown;
}

/**
`http.request`, injected so the client is tested without a socket; the request is a `Writable`.
*/
export type LocalRequestFunction = (
  options: RequestOptions,
  callback: (message: LocalMessage) => void,
) => Writable;

/**
Where `url` points: a socket path, or a host and port.
*/
export function localTarget(url: string): Pick<RequestOptions, 'socketPath' | 'host' | 'port'> {
  if (url.startsWith('unix:')) {
    return { socketPath: url.slice('unix:'.length) };
  }
  const parsed = new URL(url);
  const host =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  return { host, port: parsed.port === '' ? 80 : Number(parsed.port) };
}

export class LocalResponseTooLarge extends Error {
  constructor(limit: number) {
    super(`the response body exceeded ${String(limit)} bytes`);
    this.name = 'LocalResponseTooLarge';
  }
}

async function readCapped(message: LocalMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of message) {
    const buffer = chunk as Buffer;
    received += buffer.byteLength;
    if (received > limit) {
      message.destroy();
      throw new LocalResponseTooLarge(limit);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(outgoing: Writable, body: LocalRequest['body']): void {
  if (body === undefined || Buffer.isBuffer(body)) {
    outgoing.end(body);
    return;
  }
  void (async () => {
    try {
      await pipeline(Readable.from(body), outgoing);
    } catch {
      // A failed body stream destroys the request, whose own `error` event
      // rejects the exchange below; there is nothing left to report here.
    }
  })();
}

/**
The response head, once it arrives; the request's own error (or its abort) rejects instead.
*/
async function respond(
  request: LocalRequestFunction,
  options: RequestOptions,
  body: LocalRequest['body'],
): Promise<LocalMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request(options, resolve);
    // `on`, not `once`: a request may report a second error after the first,
    // and an `error` event nobody listens to would end the process.
    outgoing.on('error', reject);
    send(outgoing, body);
  });
}

/**
The client for one sidecar URL (ACT-113); `request` is replaceable for tests.
*/
export function createLocalHttp(
  url: string,
  request: LocalRequestFunction = httpRequest,
): LocalHttp {
  const target = localTarget(url);
  return async (local) => {
    const message = await respond(
      request,
      {
        ...target,
        method: local.method,
        path: local.path,
        headers: { connection: 'close', ...local.headers },
        signal: local.signal,
      },
      local.body,
    );
    const body = await readCapped(message, local.maxResponseBytes);
    return { status: message.statusCode ?? 0, body };
  };
}
