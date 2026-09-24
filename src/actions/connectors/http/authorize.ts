/**
 * The pure half of the `http` connector (ACT-78): the policy decision of
 * ACT-39 over an `http_request` (method, path, headers, body size; ACT-20,
 * ACT-22, ACT-34, ACT-35), the read/write classification of ACT-40, the
 * ACT-43 summary and the ACT-19 capabilities. No I/O, nothing from the
 * vault.
 */
import { isPatternMatch, type PolicyDecision } from '../../policy.ts';
import { excerptOf } from '../operation-summary.ts';

import { encodeBody, requestSubject } from './request.ts';
import { READ_METHODS } from './schemas.ts';

import type { HttpOperation } from './operation.ts';
import type { HttpCredential, HttpDestination, HttpPolicy } from './schemas.ts';
import type { OperationDescription, OperationRequest, TargetCapabilities } from '../connector.ts';

/**
 * ACT-22's fixed list plus `content-length` (the transport frames the body
 * it sends) and `user-agent` (ACT-80 fixes it); `proxy-*` by prefix.
 */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'host',
  'transfer-encoding',
  'content-length',
  'user-agent',
]);

/**
The header a credential mapping occupies, lower-cased; `query` occupies none.
*/
export function injectedHeaderName(credential: HttpCredential): string | undefined {
  switch (credential.mode) {
    case 'header': {
      return credential.name;
    }
    case 'query': {
      return undefined;
    }
    default: {
      return 'authorization';
    }
  }
}

function isForbiddenHeader(name: string, credential: HttpCredential): boolean {
  return (
    FORBIDDEN_HEADERS.has(name) ||
    name.startsWith('proxy-') ||
    name === injectedHeaderName(credential)
  );
}

/**
ACT-35 over the subject the request will actually be sent with (`requestSubject`), never another.
*/
function isPathAllowed(policy: HttpPolicy, path: string): boolean {
  const subject = requestSubject(path);
  return (
    subject !== undefined &&
    policy.allowed_paths.some((pattern) => isPatternMatch(pattern, subject, 'path'))
  );
}

function areHeadersAllowed(
  policy: HttpPolicy,
  headers: Readonly<Record<string, string>>,
  credential: HttpCredential,
): boolean {
  return Object.keys(headers)
    .map((name) => name.toLowerCase())
    .every(
      (name) =>
        !isForbiddenHeader(name, credential) && policy.allowed_request_headers.includes(name),
    );
}

export type HttpRequest = OperationRequest<HttpDestination, HttpCredential, HttpPolicy>;

export function authorize(request: HttpRequest, operation: HttpOperation): PolicyDecision {
  const { policy, credential } = request;
  if (!policy.allowed_methods.includes(operation.method)) {
    return { allowed: false, reason: 'method' };
  }
  if (!isPathAllowed(policy, operation.path)) {
    return { allowed: false, reason: 'path' };
  }
  if (!areHeadersAllowed(policy, operation.headers ?? {}, credential)) {
    return { allowed: false, reason: 'header' };
  }
  const body = encodeBody(operation);
  if (body !== undefined && body.bytes.length > policy.max_body_bytes) {
    return { allowed: false, reason: 'body_size' };
  }
  return { allowed: true, operation: READ_METHODS.has(operation.method) ? 'read' : 'write' };
}

/**
ACT-43: the method and the path as the agent gave them, excerpted and never silently; ACT-60: the method.
*/
export function describeOperation(
  _request: HttpRequest,
  operation: HttpOperation,
): OperationDescription {
  return {
    ...excerptOf(`${operation.method} ${operation.path}`),
    classification: operation.method,
  };
}

export function capabilities(
  _destination: HttpDestination,
  policy: HttpPolicy,
): TargetCapabilities {
  return {
    operations: policy.allowed_methods.map((method) => ({
      operation: READ_METHODS.has(method) ? 'read' : 'write',
      scope: 'actions:http',
    })),
  };
}
