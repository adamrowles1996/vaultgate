import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLocalHttp,
  type LocalMessage,
  type LocalRequestFunction,
  LocalResponseTooLarge,
  localTarget,
} from './local-http.ts';

interface Recorded {
  readonly options: RequestOptions[];
  readonly written: Buffer[];
}

interface FakeOptions {
  readonly status?: number | undefined;
  readonly response?: readonly string[];
  /**
  Fails the request with this error instead of answering.
  */
  readonly error?: Error;
}

function message(chunks: readonly string[], statusCode: number | undefined): LocalMessage {
  return Object.assign(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), { statusCode });
}

/**
A request that records what is written to it and answers once the body has ended.
*/
function fakeRequest(options: FakeOptions = {}): {
  request: LocalRequestFunction;
  recorded: Recorded;
} {
  const recorded: Recorded = { options: [], written: [] };
  const request: LocalRequestFunction = (requestOptions, callback) => {
    recorded.options.push(requestOptions);
    const outgoing = new Writable({
      write(chunk: Buffer, _encoding, done) {
        recorded.written.push(chunk);
        done();
      },
      final(done) {
        if (options.error === undefined) {
          callback(
            message(
              options.response ?? ['{"ok":true}'],
              'status' in options ? options.status : 200,
            ),
          );
          done();
        } else {
          done(options.error);
        }
      },
    });
    return outgoing;
  };
  return { request, recorded };
}

const signal = new AbortController().signal;

function streamed(parts: readonly string[], failure?: Error): AsyncIterable<Uint8Array> {
  const buffers = parts.map((part) => Buffer.from(part));
  return failure === undefined
    ? Readable.from(buffers)
    : Readable.from(
        (function* failing() {
          yield* buffers;
          throw failure;
        })(),
      );
}

describe('where a sidecar URL points (ACT-113)', () => {
  it('ACT-113 reads unix: as a socket path and http:// as a host and port', () => {
    expect(localTarget('unix:/run/vaultgate-code/sidecar.sock')).toStrictEqual({
      socketPath: '/run/vaultgate-code/sidecar.sock',
    });
    expect(localTarget('http://code:8080')).toStrictEqual({ host: 'code', port: 8080 });
    expect(localTarget('http://10.0.0.5')).toStrictEqual({ host: '10.0.0.5', port: 80 });
    expect(localTarget('http://[fd00::7]:9000/')).toStrictEqual({ host: 'fd00::7', port: 9000 });
  });
});

describe('the local HTTP client (ACT-113)', () => {
  it('ACT-113 sends the method, path and headers with connection: close to the socket, and answers status and body', async () => {
    const { request, recorded } = fakeRequest({ status: 201, response: ['{"a":', '1}'] });
    const http = createLocalHttp('unix:/run/sidecar.sock', request);
    const answer = await http({
      method: 'POST',
      path: '/v1/search',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"q":1}'),
      signal,
      maxResponseBytes: 64,
    });
    expect([answer.status, answer.body.toString('utf8')]).toStrictEqual([201, '{"a":1}']);
    expect(recorded.options).toStrictEqual([
      {
        socketPath: '/run/sidecar.sock',
        method: 'POST',
        path: '/v1/search',
        headers: { connection: 'close', 'content-type': 'application/json' },
        signal,
      },
    ]);
    expect(Buffer.concat(recorded.written).toString('utf8')).toBe('{"q":1}');
  });

  it('ACT-105 writes a streamed body as it arrives and ends the request with it', async () => {
    const { request, recorded } = fakeRequest();
    const http = createLocalHttp('http://code:8080', request);
    await http({
      method: 'PUT',
      path: '/v1/snapshots/k',
      body: streamed(['one', 'two']),
      signal,
      maxResponseBytes: 64,
    });
    expect(recorded.written.map((chunk) => chunk.toString('utf8'))).toStrictEqual(['one', 'two']);
    expect(recorded.options[0]).toMatchObject({
      host: 'code',
      port: 8080,
      headers: { connection: 'close' },
    });
  });

  it('ACT-105 a body stream that fails fails the request with that error', async () => {
    const { request } = fakeRequest();
    const cut = new Error('archive_too_large');
    const http = createLocalHttp('unix:/s.sock', request);
    await expect(
      http({
        method: 'PUT',
        path: '/v1/snapshots/k',
        body: streamed(['one'], cut),
        signal,
        maxResponseBytes: 64,
      }),
    ).rejects.toBe(cut);
  });

  it('ACT-113 a request that fails rejects, and a GET sends no body', async () => {
    const refused = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    const { request, recorded } = fakeRequest({ error: refused });
    const http = createLocalHttp('unix:/s.sock', request);
    await expect(
      http({ method: 'GET', path: '/v1/health', signal, maxResponseBytes: 64 }),
    ).rejects.toBe(refused);
    expect(recorded.written).toStrictEqual([]);
  });

  it('ACT-113 reads the response up to the cap and no further', async () => {
    const { request } = fakeRequest({ response: ['12345', '67890'] });
    const http = createLocalHttp('unix:/s.sock', request);
    await expect(
      http({ method: 'GET', path: '/v1/snapshots', signal, maxResponseBytes: 9 }),
    ).rejects.toStrictEqual(new LocalResponseTooLarge(9));
    const exact = await createLocalHttp(
      'unix:/s.sock',
      fakeRequest({ response: ['12345'] }).request,
    )({
      method: 'GET',
      path: '/v1/snapshots',
      signal,
      maxResponseBytes: 5,
    });
    expect(exact.body.toString('utf8')).toBe('12345');
  });

  it('ACT-113 a response without a status reads as 0', async () => {
    const { request } = fakeRequest({ status: undefined });
    const answer = await createLocalHttp(
      'unix:/s.sock',
      request,
    )({ method: 'GET', path: '/', signal, maxResponseBytes: 64 });
    expect(answer.status).toBe(0);
  });
});

describe('the local HTTP client over a real Unix socket (ACT-114)', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ACT-105 ACT-114 streams a body to a server on a Unix socket and reads its answer', async () => {
    directory = mkdtempSync(join(tmpdir(), 'vg-local-http-'));
    const socket = join(directory, 'sidecar.sock');
    const received: string[] = [];
    const server = createServer((incoming, outgoing) => {
      incoming.on('data', (chunk: Buffer) => {
        received.push(chunk.toString('utf8'));
      });
      incoming.on('end', () => {
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({
            method: incoming.method,
            url: incoming.url,
            close: incoming.headers.connection,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const http = createLocalHttp(`unix:${socket}`);
      const answer = await http({
        method: 'PUT',
        path: '/v1/snapshots/k',
        body: streamed(['gzip ', 'bytes']),
        signal,
        maxResponseBytes: 1024,
      });
      expect(JSON.parse(answer.body.toString('utf8'))).toStrictEqual({
        method: 'PUT',
        url: '/v1/snapshots/k',
        close: 'close',
      });
      expect(received.join('')).toBe('gzip bytes');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
