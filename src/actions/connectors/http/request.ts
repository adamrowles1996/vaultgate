/**
 * The request an `http_request` becomes (ACT-20, ACT-79, ACT-80): the URL
 * under `base_url`, the agent's headers with vaultgate's `User-Agent`, the
 * body, and the credential in its injection point (`bearer`, `basic`,
 * `header` or `query`). Built once per hop; the credential is applied again
 * only to a hop that stays under `base_url` (ACT-22).
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';
import { httpSubject } from '../../policy.ts';

import type { HttpOperation } from './operation.ts';
import type { HttpCredential } from './schemas.ts';
import type { PinnedMethod, PinnedRequest } from '../../../net/pinned-https.ts';
import type { InjectedValues } from '../../scrub.ts';

export interface EncodedBody {
  readonly bytes: Buffer;
  /**
  A JSON value the agent gave, serialised here; `Content-Type: application/json` unless the agent set one.
  */
  readonly isJson: boolean;
}

export interface OutgoingRequest {
  readonly url: URL;
  readonly method: PinnedMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | undefined;
}

/**
Where the credential goes: one header, or one query parameter (ACT-79).
*/
export type Injection =
  | { readonly kind: 'header'; readonly name: string; readonly value: string }
  | { readonly kind: 'query'; readonly name: string; readonly value: string };

const CONTENT_TYPE = 'content-type';

export function encodeBody(operation: HttpOperation): EncodedBody | undefined {
  if (operation.body === undefined) {
    return undefined;
  }
  return typeof operation.body === 'string'
    ? { bytes: Buffer.from(operation.body, 'utf8'), isJson: false }
    : { bytes: Buffer.from(JSON.stringify(operation.body), 'utf8'), isJson: true };
}

function basePath(baseUrl: string): string {
  return new URL(baseUrl).pathname.replace(/\/+$/u, '');
}

/**
 * The policy subject (ACT-35) an `http_request` will be sent with, or
 * `undefined` when the path climbs above `base_url` or carries an empty
 * segment: a leading `//` is a protocol-relative URL naming another host
 * (ACT-20). `authorize` and `buildRequest` share it, so the policy judges
 * exactly the path the wire sees.
 */
export function requestSubject(path: string): string | undefined {
  const subject = httpSubject(path);
  if (subject === undefined) {
    return undefined;
  }
  const queryAt = subject.indexOf('?');
  const pathPart = queryAt === -1 ? subject : subject.slice(0, queryAt);
  return pathPart.includes('//') ? undefined : subject;
}

/**
`base_url` plus the normalised subject: the base's path prefix, then the subject, on the base's origin.
*/
export function resolveUnderBase(baseUrl: string, subject: string): URL {
  return new URL(basePath(baseUrl) + subject, baseUrl);
}

/**
ACT-20, ACT-22: same origin and the base's path prefix, on a segment boundary.
*/
export function isUnderBase(url: URL, baseUrl: string): boolean {
  const base = new URL(baseUrl);
  const prefix = basePath(baseUrl);
  return (
    url.origin === base.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
  );
}

function lowerCased(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function basicInjection(
  username: string | undefined,
  value: string,
): Result<Injection, ActionError> {
  if (username === undefined) {
    return fail(new ActionError('credential_unavailable'));
  }
  const pair = Buffer.from(`${username}:${value}`, 'utf8').toString('base64');
  return ok({ kind: 'header', name: 'authorization', value: `Basic ${pair}` });
}

function prefixedInjection(
  credential: Extract<HttpCredential, { mode: 'bearer' | 'header' | 'query' }>,
  value: string,
): Injection {
  switch (credential.mode) {
    case 'bearer': {
      return { kind: 'header', name: 'authorization', value: `Bearer ${value}` };
    }
    case 'header': {
      return { kind: 'header', name: credential.name, value: `${credential.prefix ?? ''}${value}` };
    }
    case 'query': {
      return { kind: 'query', name: credential.name, value: `${credential.prefix ?? ''}${value}` };
    }
  }
}

/**
 * ACT-79: the value in its injection point, or `credential_unavailable`
 * when the call holds no value for it. `graph` has no runtime until M10
 * and is refused at save (and again on read), so it never reaches here
 * through the engine.
 */
export function credentialInjection(
  credential: HttpCredential,
  injected: InjectedValues,
): Result<Injection, ActionError> {
  if (credential.mode === 'graph') {
    return fail(new ActionError('credential_unavailable'));
  }
  const value = injected.value(credential.field)?.toString('utf8');
  if (value === undefined) {
    return fail(new ActionError('credential_unavailable'));
  }
  return credential.mode === 'basic'
    ? basicInjection(injected.username, value)
    : ok(prefixedInjection(credential, value));
}

export interface Injected {
  readonly url: URL;
  readonly headers: OutgoingRequest['headers'];
}

/**
 * The credential into the URL or the headers. A query credential is appended
 * URL-encoded (`encodeURIComponent`, one of the ACT-51 scrub variants) after
 * whatever query the agent gave.
 */
export function inject(
  url: URL,
  headers: Readonly<Record<string, string>>,
  injection: Injection,
): Injected {
  if (injection.kind === 'header') {
    return { url, headers: { ...headers, [injection.name]: injection.value } };
  }
  const parameter = `${encodeURIComponent(injection.name)}=${encodeURIComponent(injection.value)}`;
  const withQuery = new URL(url);
  withQuery.search = url.search === '' ? `?${parameter}` : `${url.search}&${parameter}`;
  return { url: withQuery, headers };
}

export interface BuildInput {
  readonly baseUrl: string;
  readonly operation: HttpOperation;
  readonly injection: Injection;
  readonly version: string;
}

/**
The first request of a call: the subject under `base_url`, the agent's headers, the body, the credential.
*/
export function buildRequest(input: BuildInput): Result<OutgoingRequest, ActionError> {
  const { operation } = input;
  const subject = requestSubject(operation.path);
  const url = subject === undefined ? undefined : resolveUnderBase(input.baseUrl, subject);
  // ACT-20: the same check every redirect hop gets; a URL parser can still move the host
  // (a backslash becomes a slash on a special scheme), so the built URL is judged, not the path.
  if (url === undefined || !isUnderBase(url, input.baseUrl)) {
    return fail(new ActionError('policy_denied', { reason: 'path' }));
  }
  const body = encodeBody(operation);
  const headers = lowerCased(operation.headers ?? {});
  if (body?.isJson === true && !Object.hasOwn(headers, CONTENT_TYPE)) {
    headers[CONTENT_TYPE] = 'application/json';
  }
  headers['user-agent'] = `vaultgate/${input.version}`;
  const injected = inject(url, headers, input.injection);
  return ok({ ...injected, method: operation.method, body: body?.bytes });
}

export function toPinned(
  request: OutgoingRequest,
  address: string,
  signal: AbortSignal,
): PinnedRequest {
  return {
    url: request.url.href,
    address,
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
  };
}
