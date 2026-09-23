import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../../../test-support/result.ts';
import { createSecretHolder } from '../../secrets.ts';

import {
  bearerInjection,
  buildRequest,
  credentialInjection,
  encodeBody,
  inject,
  isUnderBase,
  requestSubject,
  resolveUnderBase,
  toPinned,
} from './request.ts';

import type { HttpOperation } from './operation.ts';
import type { HttpCredential } from './schemas.ts';
import type { InjectedValues } from '../../scrub.ts';

const BASE = 'https://api.example.com/v1';
const BEARER: HttpCredential = { mode: 'bearer', field: 'password' };
const BASIC: HttpCredential = { mode: 'basic', field: 'password', username_from: 'login.username' };
const BEARER_INJECTION = {
  kind: 'header',
  name: 'authorization',
  value: 'Bearer secret-value',
} as const;

function injected(value = 'secret-value', username?: string): InjectedValues {
  return createSecretHolder([{ field: 'password', value: Buffer.from(value, 'utf8') }], username)
    .injected;
}

const VALUES = injected();
const WITH_USERNAME = injected('secret-value', 'alice');

function build(
  operation: HttpOperation,
  overrides: Partial<Parameters<typeof buildRequest>[0]> = {},
): ReturnType<typeof buildRequest> {
  return buildRequest({
    baseUrl: BASE,
    operation,
    injection: BEARER_INJECTION,
    version: '1.2.3',
    ...overrides,
  });
}

describe('credentialInjection', () => {
  it('ACT-79 puts the value in the bearer, basic, header and query points, with the optional prefix', () => {
    expect(unwrapOk(credentialInjection(BEARER, VALUES))).toStrictEqual(BEARER_INJECTION);
    expect(unwrapOk(credentialInjection(BASIC, WITH_USERNAME))).toStrictEqual({
      kind: 'header',
      name: 'authorization',
      value: `Basic ${Buffer.from('alice:secret-value').toString('base64')}`,
    });
    expect(
      unwrapOk(
        credentialInjection(
          { mode: 'header', field: 'password', name: 'x-api-key', prefix: 'Token ' },
          VALUES,
        ),
      ),
    ).toStrictEqual({ kind: 'header', name: 'x-api-key', value: 'Token secret-value' });
    expect(
      unwrapOk(
        credentialInjection({ mode: 'header', field: 'password', name: 'x-api-key' }, VALUES),
      ),
    ).toStrictEqual({ kind: 'header', name: 'x-api-key', value: 'secret-value' });
    expect(
      unwrapOk(credentialInjection({ mode: 'query', field: 'password', name: 'key' }, VALUES)),
    ).toStrictEqual({ kind: 'query', name: 'key', value: 'secret-value' });
    expect(
      unwrapOk(
        credentialInjection(
          { mode: 'query', field: 'password', name: 'key', prefix: 'v1-' },
          VALUES,
        ),
      ),
    ).toStrictEqual({ kind: 'query', name: 'key', value: 'v1-secret-value' });
  });

  it('ACT-79 ACT-54 answers credential_unavailable for basic without a username and for a field the call does not hold', () => {
    expect(unwrapFail(credentialInjection(BASIC, VALUES)).code).toBe('credential_unavailable');
    expect(
      unwrapFail(credentialInjection({ mode: 'bearer', field: 'custom.other' }, VALUES)).code,
    ).toBe('credential_unavailable');
  });

  it('ACT-82 puts a graph access token in the same Authorization header a bearer credential uses', () => {
    expect(bearerInjection('access-token')).toStrictEqual({
      kind: 'header',
      name: 'authorization',
      value: 'Bearer access-token',
    });
  });
});

describe('the request URL', () => {
  it('ACT-20 appends the normalised subject under base_url whatever the base path prefix or trailing slash', () => {
    expect(resolveUnderBase('https://api.example.com/v1', '/me').href).toBe(
      'https://api.example.com/v1/me',
    );
    expect(resolveUnderBase('https://api.example.com/v1/', '/me?x=1').href).toBe(
      'https://api.example.com/v1/me?x=1',
    );
    expect(resolveUnderBase('https://api.example.com', '/me').href).toBe(
      'https://api.example.com/me',
    );
    expect(resolveUnderBase('http://intranet.example:8080/', '/').href).toBe(
      'http://intranet.example:8080/',
    );
  });

  it('ACT-20 ACT-22 a URL is under base_url when it shares the origin and the base path on a segment boundary', () => {
    const under = ['/v1', '/v1/', '/v1/x/y?q=1'].map((path) =>
      isUnderBase(new URL(`https://api.example.com${path}`), BASE),
    );
    expect(under).toStrictEqual([true, true, true]);
    const outside = [
      'https://api.example.com/v1x',
      'https://api.example.com/v2/x',
      'https://api.example.com/',
      'https://api.example.com:8443/v1/x',
      'http://api.example.com/v1/x',
      'https://other.example.com/v1/x',
    ].map((href) => isUnderBase(new URL(href), BASE));
    expect(outside).toStrictEqual([false, false, false, false, false, false]);
    expect(
      isUnderBase(new URL('https://api.example.com/anything'), 'https://api.example.com'),
    ).toBe(true);
  });
});

describe('buildRequest', () => {
  it('ACT-80 ACT-79 ACT-20 lower-cases the agent headers, adds the User-Agent and the credential, resolves the path and sends a string body as UTF-8', () => {
    const request = unwrapOk(
      build({
        method: 'POST',
        path: '/items?x=%41',
        headers: { Accept: 'text/plain' },
        body: 'raw é',
      }),
    );
    expect(request.url.href).toBe('https://api.example.com/v1/items?x=A');
    expect(request.method).toBe('POST');
    expect(request.headers).toStrictEqual({
      accept: 'text/plain',
      'user-agent': 'vaultgate/1.2.3',
      authorization: 'Bearer secret-value',
    });
    expect(request.body?.toString('utf8')).toBe('raw é');
    expect(request.body?.length).toBe(6);
  });

  it('ACT-20 serialises a JSON body with Content-Type: application/json unless the agent set a content type, and sets none without a body', () => {
    const json = unwrapOk(build({ method: 'POST', path: '/x', body: { a: [1, null] } }));
    expect(json.headers['content-type']).toBe('application/json');
    expect(json.body?.toString('utf8')).toBe('{"a":[1,null]}');
    const typed = unwrapOk(
      build({
        method: 'POST',
        path: '/x',
        headers: { 'Content-Type': 'application/vnd.api+json' },
        body: [1],
      }),
    );
    expect(typed.headers['content-type']).toBe('application/vnd.api+json');
    const none = unwrapOk(build({ method: 'GET', path: '/x' }));
    expect(none.body).toBeUndefined();
    expect(Object.keys(none.headers)).toStrictEqual(['user-agent', 'authorization']);
    const text = unwrapOk(build({ method: 'POST', path: '/x', body: 'plain' }));
    expect(Object.keys(text.headers)).not.toContain('content-type');
    expect(encodeBody({ method: 'GET', path: '/' })).toBeUndefined();
  });

  it('ACT-79 ACT-51 appends a query credential URL-encoded after the agent query, or as the only query, and leaves the headers alone', () => {
    const query = { kind: 'query', name: 'api key', value: 'two words&more' } as const;
    const after = unwrapOk(build({ method: 'GET', path: '/x?a=1' }, { injection: query }));
    expect(after.url.href).toBe('https://api.example.com/v1/x?a=1&api%20key=two%20words%26more');
    const only = unwrapOk(build({ method: 'GET', path: '/x' }, { injection: query }));
    expect(only.url.href).toBe('https://api.example.com/v1/x?api%20key=two%20words%26more');
    expect(only.headers).toStrictEqual({ 'user-agent': 'vaultgate/1.2.3' });
    const url = new URL('https://api.example.com/v1/x');
    const withHeader = inject(url, { accept: '*/*' }, BEARER_INJECTION);
    expect(withHeader.url).toBe(url);
    expect(withHeader.headers).toStrictEqual({
      accept: '*/*',
      authorization: 'Bearer secret-value',
    });
  });

  it('ACT-20 ACT-39 refuses a path that climbs above base_url even when called without authorize, with reason path', () => {
    expect(unwrapFail(build({ method: 'GET', path: '/%2e%2e/x' }))).toMatchObject({
      code: 'policy_denied',
      detail: { reason: 'path' },
    });
  });

  it('ACT-20 a protocol-relative path cannot change the host: buildRequest refuses an empty segment and a URL that resolves off base_url, with reason path', () => {
    for (const baseUrl of ['https://api.example.com', 'https://api.example.com/v1']) {
      for (const path of ['//evil.example/x', '/a//b']) {
        expect(unwrapFail(build({ method: 'GET', path }, { baseUrl }))).toMatchObject({
          code: 'policy_denied',
          detail: { reason: 'path' },
        });
      }
    }
    expect(requestSubject('//evil.example/x')).toBeUndefined();
    expect(requestSubject('/a//b?x=1')).toBeUndefined();
    expect(requestSubject('/a?next=//evil.example')).toBe('/a?next=//evil.example');
    expect(requestSubject('/%2e%2e/x')).toBeUndefined();
  });

  it('ACT-20 a backslash that a URL parser would turn into a host change is refused by the built-URL check, with reason path', () => {
    expect(resolveUnderBase('https://api.example.com', String.raw`/\evil.example/x`).host).toBe(
      'evil.example',
    );
    const built = build(
      { method: 'GET', path: String.raw`/\evil.example/x` },
      {
        baseUrl: 'https://api.example.com',
      },
    );
    expect(unwrapFail(built)).toMatchObject({ code: 'policy_denied', detail: { reason: 'path' } });
    const ok = unwrapOk(
      build({ method: 'GET', path: '/x' }, { baseUrl: 'https://api.example.com' }),
    );
    expect(ok.url.href).toBe('https://api.example.com/x');
  });

  it('ACT-55 toPinned carries the URL, the pinned address, the method, the headers, the body and the signal', () => {
    const request = unwrapOk(build({ method: 'PUT', path: '/x', body: 'b' }));
    const signal = AbortSignal.abort();
    expect(toPinned(request, '93.184.216.34', signal)).toStrictEqual({
      url: 'https://api.example.com/v1/x',
      address: '93.184.216.34',
      method: 'PUT',
      headers: request.headers,
      body: request.body,
      signal,
    });
  });
});
