import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { readForm, readQuery, requireField } from './form.ts';

function formRequest(body: string, contentType = 'application/x-www-form-urlencoded'): Request {
  return new Request('https://vault.example.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('readForm', () => {
  it('§3.1 parses a form-encoded body', async () => {
    const request = formRequest('a=1&b=two%20words');
    const fields = unwrapOk(await readForm(request, 1024));
    expect([...fields]).toStrictEqual([
      ['a', '1'],
      ['b', 'two words'],
    ]);
  });

  it('§3.1 accepts a charset parameter on the media type', async () => {
    const request = formRequest('a=1', 'application/x-www-form-urlencoded; charset=UTF-8');
    const fields = unwrapOk(await readForm(request, 1024));
    expect(fields.get('a')).toBe('1');
  });

  it('§3.1 rejects any other media type', async () => {
    const request = formRequest('{}', 'application/json');
    const error = unwrapFail(await readForm(request, 1024));
    expect(error.code).toBe('invalid_request');
    expect(error.description).toBe('the body must be application/x-www-form-urlencoded');
  });

  it('§3.1 rejects a missing content type', async () => {
    const request = new Request('https://vault.example.com/x', { method: 'POST', body: 'a=1' });
    request.headers.delete('content-type');
    expect(unwrapFail(await readForm(request, 1024)).code).toBe('invalid_request');
  });

  it('T21 rejects a body over the cap', async () => {
    const request = formRequest(`a=${'x'.repeat(100)}`);
    const error = unwrapFail(await readForm(request, 50));
    expect(error.description).toBe('the request body is too large');
  });

  it('RFC 6749 §3.2 rejects a repeated parameter', async () => {
    const request = formRequest('a=1&a=2');
    const error = unwrapFail(await readForm(request, 1024));
    expect(error.description).toBe('parameter "a" is repeated');
  });
});

describe('readQuery', () => {
  it('parses query parameters', () => {
    const url = new URL('https://x/?a=1&b=2');
    const fields = unwrapOk(readQuery(url));
    expect(fields.get('b')).toBe('2');
  });

  it('RFC 6749 §3.1 rejects a repeated parameter', () => {
    const url = new URL('https://x/?a=1&a=2');
    expect(unwrapFail(readQuery(url)).description).toBe('parameter "a" is repeated');
  });
});

describe('requireField', () => {
  it('returns the value when present and non-empty', () => {
    const fields = new Map([['a', '1']]);
    expect(unwrapOk(requireField(fields, 'a'))).toBe('1');
  });

  it('OAUTH-27 names the missing parameter', () => {
    const empty = new Map([['a', '']]);
    const none = new Map<string, string>();
    expect(unwrapFail(requireField(empty, 'a')).description).toBe('parameter "a" is required');
    expect(unwrapFail(requireField(none, 'b')).description).toBe('parameter "b" is required');
  });
});
