import { type DynamicRegistrationOptions, registerDynamicClient } from './clients/dynamic.ts';
import { auditPrefix } from './credentials.ts';
import { OAuthError, respondRateLimited, respondWithOAuthError } from './errors.ts';

import type { AuditSink } from './audit.ts';
import type { ClientIpResolver } from './client-ip.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { Context } from 'hono';

/**
 * OAUTH-11: 16 KiB body cap.
 */
const MAX_BODY_BYTES = 16 * 1024;

export interface RegistrationDependencies extends DynamicRegistrationOptions {
  readonly audit: AuditSink;
  /**
  10 per hour per ip (OAUTH-11).
  */
  readonly rateLimiter: RateLimiter;
  readonly clientIp: ClientIpResolver;
}

function isJsonContentType(request: Request): boolean {
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'application/json';
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!isJsonContentType(request)) {
    throw new OAuthError('invalid_client_metadata', 'the body must be application/json');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new OAuthError('invalid_client_metadata', 'the request body is too large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OAuthError('invalid_client_metadata', 'the body is not valid JSON');
  }
}

/**
 * `POST /oauth/register` (RFC 7591, OAUTH-5, OAUTH-11).
 */
export function createRegisterHandler(
  dependencies: RegistrationDependencies,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const ip = dependencies.clientIp(context.req.raw);
    const limit = dependencies.rateLimiter.take(ip);
    if (!limit.allowed) {
      return respondRateLimited(context, limit.retryAfterSeconds);
    }
    let body: unknown;
    try {
      body = await readJsonBody(context.req.raw);
    } catch (error) {
      return respondWithOAuthError(
        context,
        error instanceof OAuthError
          ? error
          : new OAuthError('invalid_client_metadata', 'the body could not be read'),
      );
    }
    const registered = registerDynamicClient(body, dependencies);
    if (!registered.ok) {
      return respondWithOAuthError(context, registered.error);
    }
    dependencies.audit.record({
      category: 'oauth',
      action: 'client_registered',
      outcome: 'success',
      clientId: registered.value.client_id,
      tokenPrefix: auditPrefix(registered.value.client_id),
      requestId: context.req.header('x-request-id'),
      ip,
      details: { redirectUris: registered.value.redirect_uris },
    });
    context.header('Cache-Control', 'no-store');
    return context.json(registered.value, 201);
  };
}
