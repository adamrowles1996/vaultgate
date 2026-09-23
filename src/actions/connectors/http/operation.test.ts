import { describe, expect, it } from 'vitest';

import {
  HTTP_REQUEST_DESCRIPTION,
  httpOperationSchema,
  httpOutputSchema,
  httpRequestTool,
} from './operation.ts';

function problem(input: unknown): string | undefined {
  return httpOperationSchema.safeParse(input).error?.issues[0]?.message;
}

const PATH_CHARACTERS =
  'must not contain whitespace, a backslash, a fragment or a control character';

describe('http_request arguments', () => {
  it('ACT-20 accepts a method, a path with a query, up to 32 headers and a string or JSON body', () => {
    expect(httpOperationSchema.parse({ method: 'GET', path: '/v1/me?fields=name' })).toStrictEqual({
      method: 'GET',
      path: '/v1/me?fields=name',
    });
    const headers = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`x-h${index}`, `v\t${index}`]),
    );
    expect(
      httpOperationSchema.parse({ method: 'POST', path: '/x', headers, body: { a: [1] } }),
    ).toStrictEqual({ method: 'POST', path: '/x', headers, body: { a: [1] } });
    expect(
      httpOperationSchema.parse({ method: 'PUT', path: '/x', body: [1, 'two'] }).body,
    ).toStrictEqual([1, 'two']);
    expect(httpOperationSchema.parse({ method: 'PATCH', path: '/x', body: 'raw' }).body).toBe(
      'raw',
    );
    expect(httpOperationSchema.parse({ method: 'GET', path: '/a?x=..' }).path).toBe('/a?x=..');
  });

  it('ACT-20 refuses a path without a leading slash, over 2 KiB, with whitespace, a backslash, a fragment, a control character or a .. segment', () => {
    expect(problem({ method: 'GET', path: 'v1/me' })).toBe('must start with /');
    expect(problem({ method: 'GET', path: 'https://evil.example/x' })).toBe('must start with /');
    expect(problem({ method: 'GET', path: `/${'a'.repeat(2048)}` })).toBe('must be at most 2 KiB');
    expect(problem({ method: 'GET', path: `/${'a'.repeat(2047)}` })).toBeUndefined();
    for (const path of ['/a b', String.raw`/a\b`, '/a#b', '/a\u{0}b', '/a\nb', '/ab']) {
      expect(problem({ method: 'GET', path })).toBe(PATH_CHARACTERS);
    }
    expect(problem({ method: 'GET', path: '/a/../b' })).toBe('must not contain a .. segment');
    expect(problem({ method: 'GET', path: '/..' })).toBe('must not contain a .. segment');
    expect(problem({ method: 'GET', path: '/..?x=1' })).toBe('must not contain a .. segment');
    expect(problem({ method: 'GET', path: '/a/..b/c' })).toBeUndefined();
  });

  it('ACT-20 a protocol-relative path cannot change the host: an empty segment anywhere in the path is refused, and a backslash stays refused', () => {
    for (const path of ['//evil.example/x', '/a//b', '/a//', '//']) {
      expect(problem({ method: 'GET', path })).toBe('must not contain an empty segment (//)');
    }
    expect(problem({ method: 'GET', path: '/a?next=//evil.example' })).toBeUndefined();
    expect(problem({ method: 'GET', path: '/' })).toBeUndefined();
    expect(problem({ method: 'GET', path: '/a/' })).toBeUndefined();
    expect(problem({ method: 'GET', path: String.raw`/\evil.example/x` })).toBe(PATH_CHARACTERS);
    expect(problem({ method: 'GET', path: String.raw`/a\b` })).toBe(PATH_CHARACTERS);
  });

  it('ACT-20 refuses more than 32 headers, a header name that is not a token, a value with CR, LF or a non-Latin-1 character, a bad method, a non-string body and an unknown key', () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`x-${index}`, 'v']));
    expect(problem({ method: 'GET', path: '/', headers: many })).toBe(
      'must have at most 32 entries',
    );
    expect(problem({ method: 'GET', path: '/', headers: { 'bad header': 'v' } })).toBe(
      '"bad header" is not a valid header name and value',
    );
    for (const value of ['v\r\nx', 'v\nx', 'vĀ', 'v\u{0}']) {
      expect(problem({ method: 'GET', path: '/', headers: { 'x-a': value } })).toBe(
        '"x-a" is not a valid header name and value',
      );
    }
    expect(problem({ method: 'GET', path: '/', headers: { 'x-a': 'café\t' } })).toBeUndefined();
    const refused = [
      { method: 'TRACE', path: '/' },
      { method: 'GET', path: '/', extra: 1 },
      { method: 'GET', path: '/', body: 1 },
      { method: 'GET', path: '/', body: null },
      { method: 'GET', path: '/', headers: { 'x-a': 1 } },
      { path: '/' },
    ];
    expect(refused.map((input) => httpOperationSchema.safeParse(input).success)).toStrictEqual(
      refused.map(() => false),
    );
  });
});

describe('http_request result and declaration', () => {
  it('ACT-21 ACT-15 the result schema is strict and carries body_encoding only as base64', () => {
    const result = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'hi',
      bytes: 2,
      truncated: false,
      duration_ms: 3,
    };
    expect(httpOutputSchema.parse(result)).toStrictEqual(result);
    expect(httpOutputSchema.parse({ ...result, body_encoding: 'base64' }).body_encoding).toBe(
      'base64',
    );
    expect(httpOutputSchema.safeParse({ ...result, body_encoding: 'hex' }).success).toBe(false);
    expect(httpOutputSchema.safeParse({ ...result, credential: 'x' }).success).toBe(false);
    expect(httpOutputSchema.safeParse({ ...result, status: '200' }).success).toBe(false);
  });

  it('ACT-17 ACT-18 declares http_request with the 13.6.1 annotations and a description that states the rules', () => {
    expect(httpRequestTool).toMatchObject({
      name: 'http_request',
      scope: 'actions:http',
      annotations: {
        title: 'HTTP request',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
    expect(httpRequestTool.inputSchema).toBe(httpOperationSchema);
    expect(httpRequestTool.outputSchema).toBe(httpOutputSchema);
    for (const phrase of [
      'actions_list_targets',
      'never returns the credential',
      'non-2xx status is a normal result',
      '401',
      'never as authentication_failed',
      'human confirmation',
      'body_encoding',
      'truncated',
      'stay under it',
    ]) {
      expect(HTTP_REQUEST_DESCRIPTION).toContain(phrase);
    }
  });
});
