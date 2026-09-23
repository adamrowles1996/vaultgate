import { describe, expect, it } from 'vitest';

import { PUBLIC_ADDRESS } from '../../../test-support/actions-fixtures.ts';
import {
  bodyText,
  coded,
  fakeTransport,
  httpConnectorOver,
  httpRunContext,
  runHttp as run,
  scripted,
  textResponse as text,
} from '../../../test-support/http-connector.ts';
import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import type { HttpOperation } from './operation.ts';

const GET: HttpOperation = { method: 'GET', path: '/me' };
const BEARER = `Bearer ${CANARY.password}`;

describe('http run', () => {
  it('ACT-80 ACT-55 ACT-58 sends the request to the pinned address with the host in the URL, the User-Agent, the credential and the body, one request per call', async () => {
    const { fake, outcome } = await run(
      scripted([text(200, 'ok')]),
      {},
      { method: 'POST', path: '/items', headers: { Accept: 'text/plain' }, body: { a: 1 } },
    );
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request).toMatchObject({
      url: 'https://api.example.com/v1/items',
      address: PUBLIC_ADDRESS,
      method: 'POST',
      headers: {
        accept: 'text/plain',
        'content-type': 'application/json',
        'user-agent': 'vaultgate/9.9.9',
        authorization: BEARER,
      },
    });
    expect(bodyText(request!)).toBe('{"a":1}');
    expect(request?.signal.aborted).toBe(false);
    expect(unwrapOk(outcome)).toStrictEqual({
      result: {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        bytes: 2,
        truncated: false,
      },
      captured: { body: Buffer.from('ok') },
    });
  });

  it('ACT-21 a 401 is a normal result with the visible headers only, never authentication_failed', async () => {
    const { outcome } = await run(
      scripted([text(401, 'nope', { 'www-authenticate': 'Bearer realm="x"', 'retry-after': '9' })]),
    );
    expect(unwrapOk(outcome).result).toStrictEqual({
      status: 401,
      headers: { 'content-type': 'text/plain', 'retry-after': '9' },
      bytes: 4,
      truncated: false,
    });
  });

  it('ACT-52 ACT-21 reads the body up to the limit plus the guard band, then reports truncated with the bytes it received', async () => {
    const big = 'a'.repeat(5000);
    const { built, outcome } = await run(scripted([text(200, big)]), {
      policy: { max_output_bytes: 1024 },
    });
    const { guardBytes } = built.context.outputLimit;
    expect(guardBytes).toBeGreaterThan(0);
    const output = unwrapOk(outcome);
    expect(output.result).toMatchObject({ bytes: 1024 + guardBytes, truncated: true });
    expect(output.captured['body']?.length).toBe(1024 + guardBytes);
  });

  it('ACT-21 a binary body comes back base64 with body_encoding', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const { outcome } = await run(
      scripted([new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })]),
    );
    const output = unwrapOk(outcome);
    expect(output.result).toMatchObject({ status: 200, body_encoding: 'base64', bytes: 10 });
    expect(output.captured['body']?.toString('ascii')).toBe(png.toString('base64'));
  });

  it('ACT-59 answers timeout when the signal aborts while waiting for the destination or while reading the body', async () => {
    const hanging = fakeTransport(() => 'hang');
    const built = httpRunContext();
    const pending = httpConnectorOver(hanging).run(built.context, GET);
    built.controller.abort();
    expect(unwrapFail(await pending).code).toBe('timeout');
    const reading = httpRunContext();
    const stalled = fakeTransport(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              reading.controller.abort();
              return Promise.reject(reading.controller.signal.reason as Error);
            },
          }),
          { status: 200, headers: { 'content-type': 'text/plain' } },
        ),
    );
    const cut = await httpConnectorOver(stalled).run(reading.context, GET);
    expect(unwrapFail(cut).code).toBe('timeout');
  });

  it('ACT-57 ACT-16 ACT-74 maps a certificate failure to tls_error and a refused connection to connection_failed, naming the code only', async () => {
    const expired = await run(scripted([coded('certificate expired', 'CERT_HAS_EXPIRED')]));
    expect(unwrapFail(expired.outcome)).toMatchObject({
      code: 'tls_error',
      detail: { reason: 'CERT_HAS_EXPIRED' },
    });
    const refused = await run(
      scripted([coded(`connect ECONNREFUSED ${PUBLIC_ADDRESS}:443`, 'ECONNREFUSED')]),
    );
    const failure = unwrapFail(refused.outcome);
    expect(failure).toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'ECONNREFUSED' },
    });
    expect(JSON.stringify(failure.detail)).not.toContain(PUBLIC_ADDRESS);
  });

  it('ACT-54 ACT-55 refuses to run without a pinned endpoint or without the credential value, sending nothing', async () => {
    const unpinned = await run(scripted([]), { pinned: [] });
    expect(unwrapFail(unpinned.outcome)).toMatchObject({
      code: 'destination_refused',
      detail: { reason: 'unpinned' },
    });
    const basic = await run(scripted([]), {
      credential: { mode: 'basic', field: 'password', username_from: 'login.username' },
      username: undefined,
    });
    expect(unwrapFail(basic.outcome).code).toBe('credential_unavailable');
    expect(unpinned.fake.requests).toStrictEqual([]);
    expect(basic.fake.requests).toStrictEqual([]);
  });

  it('ACT-20 ACT-39 refuses a climbing path before any request when called without authorize', async () => {
    const { fake, outcome } = await run(scripted([]), {}, { method: 'GET', path: '/%2e%2e/x' });
    expect(unwrapFail(outcome)).toMatchObject({
      code: 'policy_denied',
      detail: { reason: 'path' },
    });
    expect(fake.requests).toStrictEqual([]);
  });
});
