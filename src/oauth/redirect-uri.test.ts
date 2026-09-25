import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import {
  isLoopbackRedirect,
  isRegisteredRedirect,
  redirectHost,
  validateRedirectUri,
} from './redirect-uri.ts';

describe('validateRedirectUri', () => {
  it('OAUTH-6 accepts https URLs', () => {
    expect(unwrapOk(validateRedirectUri('https://app.example.com/cb'))).toBe(
      'https://app.example.com/cb',
    );
  });

  it.each([
    'http://localhost/cb',
    'http://localhost:1234/cb',
    'http://127.0.0.1:9/cb',
    'http://[::1]:8/cb',
  ])('OAUTH-6 accepts the loopback address %s on any port', (uri) => {
    expect(unwrapOk(validateRedirectUri(uri))).toBe(uri);
  });

  it.each([
    ['http://app.example.com/cb', 'must use https or a loopback http address'],
    ['http://localhost.evil.com/cb', 'must use https or a loopback http address'],
    ['ftp://localhost/cb', 'must use https or a loopback http address'],
    ['/relative', 'is not an absolute URL'],
    ['https://app.example.com/cb#frag', 'must not contain a fragment'],
    ['https://app.example.com/cb#', 'must not contain a fragment'],
    ['https://user:pw@app.example.com/cb', 'must not contain credentials'],
  ])('OAUTH-6 rejects %s', (uri, reason) => {
    expect(unwrapFail(validateRedirectUri(uri)).message).toContain(reason);
  });
});

describe('isLoopbackRedirect', () => {
  it('T7 recognises loopback http addresses only', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:5000/cb')).toBe(true);
    expect(isLoopbackRedirect('http://localhost/cb')).toBe(true);
    expect(isLoopbackRedirect('https://localhost/cb')).toBe(false);
    expect(isLoopbackRedirect('https://app.example.com/cb')).toBe(false);
    expect(isLoopbackRedirect('not a url')).toBe(false);
  });
});

describe('redirectHost', () => {
  it('OAUTH-13 shows the host with its explicit port', () => {
    expect(redirectHost('https://app.example.com:8443/cb?x=1')).toBe('app.example.com:8443');
    expect(redirectHost('http://[::1]:7000/cb')).toBe('[::1]:7000');
    expect(redirectHost('garbage')).toBe('garbage');
  });
});

describe('isRegisteredRedirect', () => {
  const registered = [
    'https://app.example.com/cb',
    'http://127.0.0.1:4000/cb',
    'http://[::1]:4000/cb',
    'http://localhost:4000/cb',
  ];

  it('OAUTH-7 matches by exact string', () => {
    expect(isRegisteredRedirect('https://app.example.com/cb', registered)).toBe(true);
    expect(isRegisteredRedirect('https://app.example.com/cb/', registered)).toBe(false);
    expect(isRegisteredRedirect('https://APP.example.com/cb', registered)).toBe(false);
  });

  it('OAUTH-7 applies the RFC 8252 port exception to loopback literals', () => {
    expect(isRegisteredRedirect('http://127.0.0.1:61234/cb', registered)).toBe(true);
    expect(isRegisteredRedirect('http://[::1]:61234/cb', registered)).toBe(true);
  });

  it('OAUTH-7 applies the port exception to localhost, as Claude Code registers it', () => {
    expect(isRegisteredRedirect('http://localhost:61234/cb', registered)).toBe(true);
    expect(
      isRegisteredRedirect('http://localhost:57877/callback', ['http://localhost/callback']),
    ).toBe(true);
  });

  it('OAUTH-7 never lets the exception cross from one loopback host to another', () => {
    expect(isRegisteredRedirect('http://localhost:61234/cb', ['http://127.0.0.1/cb'])).toBe(false);
    expect(isRegisteredRedirect('http://127.0.0.1:61234/cb', ['http://localhost/cb'])).toBe(false);
  });

  it('OAUTH-7 requires scheme, host, path and query to match under the exception', () => {
    expect(isRegisteredRedirect('http://127.0.0.1:61234/other', registered)).toBe(false);
    expect(isRegisteredRedirect('http://127.0.0.1:61234/cb?x=1', registered)).toBe(false);
    expect(isRegisteredRedirect('https://127.0.0.1:61234/cb', registered)).toBe(false);
    expect(isRegisteredRedirect('http://127.0.0.1:61234/cb', ['http://[::1]:4000/cb'])).toBe(false);
  });

  it('OAUTH-7 never matches unparsable input', () => {
    expect(isRegisteredRedirect('http://127.0.0.1:1/cb', ['not a url'])).toBe(false);
    expect(isRegisteredRedirect('nope', registered)).toBe(false);
  });
});
