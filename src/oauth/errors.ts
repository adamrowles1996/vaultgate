import type { Context } from 'hono';

/**
 * RFC 6749 §4.1.2.1 and §5.2 codes, plus RFC 7591 §3.2.2, RFC 8707 §2 and
 * the OAuth 2.1 `invalid_target` (OAUTH-27).
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'invalid_client_metadata'
  | 'invalid_redirect_uri'
  | 'temporarily_unavailable';

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * An expected protocol failure. The description is written for the client
 * developer and never carries internal ids or stack traces (OAUTH-27).
 */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly description: string;

  constructor(code: OAuthErrorCode, description: string) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
    this.code = code;
    this.description = description;
  }
}

export function oauthErrorStatus(error: OAuthError): number {
  switch (error.code) {
    case 'invalid_client': {
      return HTTP_UNAUTHORIZED;
    }
    case 'temporarily_unavailable': {
      return HTTP_TOO_MANY_REQUESTS;
    }
    default: {
      return HTTP_BAD_REQUEST;
    }
  }
}

export function oauthErrorBody(error: OAuthError): {
  readonly error: OAuthErrorCode;
  readonly error_description: string;
} {
  return { error: error.code, error_description: error.description };
}

/**
 * The JSON error response of the token, revocation and registration
 * endpoints. Never cacheable (OAUTH-26).
 */
export function respondWithOAuthError(context: Context, error: OAuthError): Response {
  context.header('Cache-Control', 'no-store');
  context.header('Pragma', 'no-cache');
  return context.json(oauthErrorBody(error), oauthErrorStatus(error) as 400);
}

/**
 * A 429 with `Retry-After` (OAUTH-28, OAUTH-11).
 */
export function respondRateLimited(context: Context, retryAfterSeconds: number): Response {
  context.header('Retry-After', String(retryAfterSeconds));
  return respondWithOAuthError(
    context,
    new OAuthError('temporarily_unavailable', 'rate limit exceeded; retry later'),
  );
}
