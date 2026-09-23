import { describe, expect, it } from 'vitest';

import { PUBLIC_ADDRESS } from '../../../test-support/actions-fixtures.ts';
import {
  redirectResponse as redirect,
  redirectThenEcho,
  runHttp as run,
  scripted,
  textResponse as text,
  urlsOf,
} from '../../../test-support/http-connector.ts';
import { unwrapOk } from '../../../test-support/result.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

import type { HttpOperation } from './operation.ts';

const BEARER = `Bearer ${CANARY.password}`;
const FOLLOW = { follow_redirects: true, allowed_methods: ['GET', 'HEAD', 'POST', 'PUT'] };

describe('http redirects', () => {
  it('ACT-22 a redirect is the result when follow_redirects is off, location included and nothing followed', async () => {
    const { fake, outcome } = await run(scripted([redirect(302, '/v1/elsewhere')]));
    expect(fake.requests).toHaveLength(1);
    expect(unwrapOk(outcome).result).toMatchObject({
      status: 302,
      headers: { location: '/v1/elsewhere' },
    });
  });

  it('ACT-22 ACT-55 follows at most two hops under base_url, re-applying the credential to the same pinned address, and returns the third redirect as it is', async () => {
    const { fake, outcome } = await run(
      scripted([
        redirect(302, '/v1/a'),
        redirect(302, 'https://api.example.com/v1/b?x=1'),
        redirect(302, '/v1/c'),
        text(200, 'never'),
      ]),
      { policy: FOLLOW },
      { method: 'GET', path: '/me', headers: { Accept: 'text/plain' } },
    );
    expect(urlsOf(fake)).toStrictEqual([
      'https://api.example.com/v1/me',
      'https://api.example.com/v1/a',
      'https://api.example.com/v1/b?x=1',
    ]);
    expect(fake.requests.map((request) => request.address)).toStrictEqual([
      PUBLIC_ADDRESS,
      PUBLIC_ADDRESS,
      PUBLIC_ADDRESS,
    ]);
    expect(fake.requests.map((request) => request.headers['authorization'])).toStrictEqual([
      BEARER,
      BEARER,
      BEARER,
    ]);
    expect(fake.requests.map((request) => request.headers['accept'])).toStrictEqual([
      'text/plain',
      'text/plain',
      'text/plain',
    ]);
    expect(unwrapOk(outcome).result).toMatchObject({ status: 302, headers: { location: '/v1/c' } });
  });

  it('ACT-22 ACT-56 does not follow a hop that leaves base_url: another origin, a private address, another scheme or port, a sibling path, no location, or an unparsable one', async () => {
    const locations = [
      'https://evil.example.com/v1/x',
      'https://10.0.0.5/v1/x',
      'https://api.example.com/v2/x',
      'https://api.example.com/v1x',
      'http://api.example.com/v1/x',
      'https://api.example.com:8443/v1/x',
      'http://[',
    ];
    for (const location of locations) {
      const { fake, outcome } = await run(scripted([redirect(302, location)]), { policy: FOLLOW });
      expect(fake.requests).toHaveLength(1);
      expect(unwrapOk(outcome).result).toMatchObject({ status: 302, headers: { location } });
    }
    const bare = await run(scripted([new Response('x', { status: 302 })]), { policy: FOLLOW });
    expect(bare.fake.requests).toHaveLength(1);
    expect(unwrapOk(bare.outcome).result).toMatchObject({ status: 302, headers: {} });
  });

  it('ACT-22 a redirect to a protocol-relative location outside base_url is not followed, nor one whose backslash a parser would read as a host', async () => {
    for (const location of [
      '//evil.example/v1/x',
      String.raw`/\evil.example/v1/x`,
      '//api.example.com:8443/v1/x',
    ]) {
      const { fake, outcome } = await run(scripted([redirect(302, location)]), { policy: FOLLOW });
      expect(fake.requests).toHaveLength(1);
      expect(unwrapOk(outcome).result).toMatchObject({ status: 302, headers: { location } });
    }
    const same = await run(scripted([redirect(302, '//api.example.com/v1/x'), text(200, 'ok')]), {
      policy: FOLLOW,
    });
    expect(urlsOf(same.fake)).toStrictEqual([
      'https://api.example.com/v1/me',
      'https://api.example.com/v1/x',
    ]);
  });

  it('ACT-22 turns POST into GET without its body on 301, 302 and 303, keeps HEAD on 303, and keeps method and body on 307 and 308', async () => {
    const cases: readonly [number, HttpOperation['method'], HttpOperation['method']][] = [
      [301, 'POST', 'GET'],
      [302, 'POST', 'GET'],
      [303, 'POST', 'GET'],
      [303, 'PUT', 'GET'],
      [303, 'HEAD', 'HEAD'],
      [301, 'PUT', 'PUT'],
      [307, 'POST', 'POST'],
      [308, 'PUT', 'PUT'],
    ];
    for (const [status, method, expected] of cases) {
      const { fake } = await run(
        scripted([redirect(status, '/v1/next'), text(200, 'done')]),
        { policy: FOLLOW },
        { method, path: '/me', body: { a: 1 } },
      );
      const [, hop] = fake.requests;
      expect(hop?.method).toBe(expected);
      const isKeptBody = expected === method;
      expect(hop?.body === undefined).toBe(!isKeptBody);
      expect('content-type' in (hop?.headers ?? {})).toBe(isKeptBody);
      expect(hop?.headers['authorization']).toBe(BEARER);
    }
  });

  it('ACT-79 ACT-22 re-appends a query credential on a hop and drains a redirect body, whether it has one or not', async () => {
    const query = {
      credential: { mode: 'query', field: 'password', name: 'key' } as const,
      policy: { ...FOLLOW, allow_query_credentials: true },
    };
    const withBody = await run(redirectThenEcho('/v1/next?x=1'), query);
    expect(withBody.fake.requests).toHaveLength(2);
    expect(urlsOf(withBody.fake)[1]).toBe(
      `https://api.example.com/v1/next?x=1&key=${encodeURIComponent(CANARY.password)}`,
    );
    const nullBody = await run(scripted([redirect(302, '/v1/next', null), text(200, 'ok')]), query);
    expect(urlsOf(nullBody.fake)).toStrictEqual([
      `https://api.example.com/v1/me?key=${encodeURIComponent(CANARY.password)}`,
      `https://api.example.com/v1/next?key=${encodeURIComponent(CANARY.password)}`,
    ]);
    expect(unwrapOk(nullBody.outcome).result).toMatchObject({ status: 200 });
  });
});
