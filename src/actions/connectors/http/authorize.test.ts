import { describe, expect, it } from 'vitest';

import {
  authorize as authorizeRequest,
  capabilities,
  describeOperation,
  injectedHeaderName,
  type HttpRequest,
} from './authorize.ts';
import {
  type HttpCredential,
  type HttpDestination,
  type HttpPolicy,
  httpPolicySchema,
} from './schemas.ts';

import type { HttpOperation } from './operation.ts';
import type { PolicyDecision } from '../../policy.ts';

const DESTINATION: HttpDestination = { base_url: 'https://api.example.com/v1' };

/**
The documents and the tool `authorize` judges against; only the policy and the credential vary here.
*/
function request(policy: HttpPolicy, credential: HttpCredential): HttpRequest {
  return { destination: DESTINATION, credential, policy, tool: 'http_request' };
}

function authorize(
  policy: HttpPolicy,
  operation: HttpOperation,
  credential: HttpCredential,
): PolicyDecision {
  return authorizeRequest(request(policy, credential), operation);
}

const BEARER: HttpCredential = { mode: 'bearer', field: 'password' };
const KEYED: HttpCredential = { mode: 'header', field: 'password', name: 'x-api-key' };
const QUERY: HttpCredential = { mode: 'query', field: 'password', name: 'key' };
const DENIED_PATH = { allowed: false, reason: 'path' } as const;
const DENIED_HEADER = { allowed: false, reason: 'header' } as const;
const DENIED_BODY = { allowed: false, reason: 'body_size' } as const;

function policy(overrides: Readonly<Record<string, unknown>> = {}): HttpPolicy {
  return httpPolicySchema.parse({ allowed_paths: ['/**'], ...overrides });
}

const DEFAULT = policy();
const FIVE = 'é'.repeat(5);
const SIX = 'é'.repeat(6);

function get(path: string, extra: Partial<HttpOperation> = {}): HttpOperation {
  return { method: 'GET', path, ...extra };
}

function post(body: HttpOperation['body']): HttpOperation {
  return { method: 'POST', path: '/x', body };
}

describe('authorize', () => {
  it('ACT-39 ACT-40 ACT-78 allows what the policy allows and classifies GET, HEAD and OPTIONS as read, every other method as write', () => {
    const open = policy({
      allowed_methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
    });
    const decisions = open.allowed_methods.map((method) =>
      authorize(open, { method, path: '/x' }, BEARER),
    );
    expect(decisions).toStrictEqual([
      { allowed: true, operation: 'read' },
      { allowed: true, operation: 'read' },
      { allowed: true, operation: 'read' },
      { allowed: true, operation: 'write' },
      { allowed: true, operation: 'write' },
      { allowed: true, operation: 'write' },
      { allowed: true, operation: 'write' },
    ]);
  });

  it('ACT-39 refuses a method outside allowed_methods with reason method, before anything else', () => {
    expect(authorize(DEFAULT, post('xxxxxxxxxx'), BEARER)).toStrictEqual({
      allowed: false,
      reason: 'method',
    });
    expect(authorize(policy(), { method: 'DELETE', path: '/../x' }, BEARER)).toStrictEqual({
      allowed: false,
      reason: 'method',
    });
  });

  it('ACT-34 ACT-35 ACT-39 matches the normalised path and query against allowed_paths and refuses with reason path', () => {
    const scoped = policy({ allowed_paths: ['/users/*', '/reports/**'] });
    expect(authorize(scoped, get('/users/1?fields=name'), BEARER).allowed).toBe(true);
    expect(authorize(scoped, get('/users/%31'), BEARER).allowed).toBe(true);
    expect(authorize(scoped, get('/users/./1'), BEARER).allowed).toBe(true);
    expect(authorize(scoped, get('/reports/2026/q1'), BEARER).allowed).toBe(true);
    expect(authorize(scoped, get('/users/1/posts'), BEARER)).toStrictEqual(DENIED_PATH);
    expect(authorize(scoped, get('/users/1?next=/a'), BEARER)).toStrictEqual(DENIED_PATH);
    expect(authorize(scoped, get('/Users/1'), BEARER)).toStrictEqual(DENIED_PATH);
    expect(authorize(scoped, get('/users'), BEARER)).toStrictEqual(DENIED_PATH);
    expect(authorize(policy(), get('/%2e%2e/admin'), BEARER)).toStrictEqual(DENIED_PATH);
    expect(authorize(policy(), get('/a/%2E%2E/%2e%2E/x'), BEARER)).toStrictEqual(DENIED_PATH);
    expect(authorize(policy(), get('/a/%2E%2E/b'), BEARER).allowed).toBe(true);
  });

  it('ACT-20 a protocol-relative path cannot change the host: authorize judges the subject the request will use and refuses an empty segment with reason path', () => {
    for (const path of ['//evil.example/x', '/a//b', '//']) {
      expect(authorize(policy(), get(path), BEARER)).toStrictEqual(DENIED_PATH);
    }
    expect(authorize(policy(), get('/a?next=//evil.example'), BEARER).allowed).toBe(true);
  });

  it('ACT-22 ACT-39 refuses Authorization, Cookie, Host, Content-Length, User-Agent, Transfer-Encoding, Proxy-* and the credential header whatever the allowlist says, and any header outside it', () => {
    const permissive = policy({
      allowed_request_headers: [
        'authorization',
        'cookie',
        'host',
        'content-length',
        'user-agent',
        'transfer-encoding',
        'proxy-authorization',
        'x-api-key',
        'accept',
      ],
    });
    for (const name of [
      'Authorization',
      'cookie',
      'HOST',
      'content-length',
      'User-Agent',
      'transfer-encoding',
      'Proxy-Authorization',
      'proxy-connection',
    ]) {
      expect(authorize(permissive, get('/x', { headers: { [name]: 'v' } }), BEARER)).toStrictEqual(
        DENIED_HEADER,
      );
    }
    expect(
      authorize(permissive, get('/x', { headers: { 'X-Api-Key': 'mine' } }), KEYED),
    ).toStrictEqual(DENIED_HEADER);
    expect(
      authorize(permissive, get('/x', { headers: { 'X-Api-Key': 'mine' } }), BEARER).allowed,
    ).toBe(true);
    expect(
      authorize(permissive, get('/x', { headers: { accept: 'text/plain' } }), QUERY).allowed,
    ).toBe(true);
    expect(authorize(policy(), get('/x', { headers: { 'X-Trace': '1' } }), BEARER)).toStrictEqual(
      DENIED_HEADER,
    );
    expect(
      authorize(
        policy(),
        get('/x', { headers: { Accept: 'text/plain', 'If-None-Match': '"e"' } }),
        BEARER,
      ).allowed,
    ).toBe(true);
  });

  it('ACT-22 names the header each credential mode occupies', () => {
    expect(injectedHeaderName(BEARER)).toBe('authorization');
    expect(
      injectedHeaderName({ mode: 'basic', field: 'password', username_from: 'login.username' }),
    ).toBe('authorization');
    expect(injectedHeaderName(KEYED)).toBe('x-api-key');
    expect(injectedHeaderName(QUERY)).toBeUndefined();
  });

  it('ACT-39 refuses a body over max_body_bytes with reason body_size, counting UTF-8 bytes and the JSON serialisation', () => {
    const small = policy({ allowed_methods: ['POST'], max_body_bytes: 10 });
    expect(authorize(small, post('0123456789'), BEARER).allowed).toBe(true);
    expect(authorize(small, post('01234567890'), BEARER)).toStrictEqual(DENIED_BODY);
    expect(authorize(small, post(FIVE), BEARER).allowed).toBe(true);
    expect(authorize(small, post(SIX), BEARER)).toStrictEqual(DENIED_BODY);
    expect(authorize(small, post({ a: 'eleven' }), BEARER)).toStrictEqual(DENIED_BODY);
    expect(authorize(small, post({ a: 1 }), BEARER).allowed).toBe(true);
    expect(authorize(small, post(undefined), BEARER).allowed).toBe(true);
  });

  it('ACT-43 ACT-60 describes the operation as method and path, capped at 1 KiB, classified by method', () => {
    const described = request(DEFAULT, BEARER);
    expect(
      describeOperation(described, { method: 'DELETE', path: '/v1/items/7?force=1' }),
    ).toStrictEqual({ summary: 'DELETE /v1/items/7?force=1', classification: 'DELETE' });
    const long = describeOperation(described, { method: 'GET', path: `/${'a'.repeat(2000)}` });
    expect(long.summary).toHaveLength(1024);
    expect(long.summary.startsWith('GET /aaa')).toBe(true);
  });

  it('ACT-19 reports one operation per allowed method with the actions:http scope', () => {
    expect(
      capabilities(
        { base_url: 'https://api.example.com' },
        policy({ allowed_methods: ['GET', 'POST'] }),
      ),
    ).toStrictEqual({
      operations: [
        { operation: 'read', scope: 'actions:http' },
        { operation: 'write', scope: 'actions:http' },
      ],
    });
  });
});
