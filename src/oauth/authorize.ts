import { parseAuthorizationRequest, toPendingParameters } from './authorize-request.ts';
import {
  type AuthorizeDeps,
  PENDING_TTL_MS,
  ensureBindingCookie,
  errorPage,
  isBoundToBrowser,
  livePending,
  loginRedirect,
  rateLimitKey,
  redirectWithError,
} from './authorize-shared.ts';
import { renderConsentPage } from './consent-page.ts';
import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { OAuthError } from './errors.ts';
import { HTML_HEADERS } from './html.ts';
import { isScope, type Scope } from './scopes.ts';

import type { Context } from 'hono';
import type { ClientMode } from './repositories/clients.ts';
import type { PendingAuthorizationRecord } from './repositories/pending-authorizations.ts';

function tooManyRequests(context: Context, retryAfterSeconds: number): Response {
  context.header('Retry-After', String(retryAfterSeconds));
  return errorPage(
    context,
    new OAuthError('temporarily_unavailable', 'too many authorization requests; retry later'),
    429,
  );
}

/**
 * `GET /oauth/authorize` (OAUTH-14…17): validate, park the request
 * server-side under a random id bound to this browser, and send the operator
 * to log in or to the consent page.
 */
export function createAuthorizeHandler(deps: AuthorizeDeps): (context: Context) => Promise<Response> {
  return async (context) => {
    const session = await deps.sessions.resolve(context.req.raw);
    const limit = deps.rateLimiter.take(rateLimitKey(context, deps, session));
    if (!limit.allowed) {
      return tooManyRequests(context, limit.retryAfterSeconds);
    }
    const parsed = await parseAuthorizationRequest(new URL(context.req.url), deps);
    if (!parsed.ok) {
      return parsed.error.kind === 'page'
        ? errorPage(context, parsed.error.error, 400)
        : redirectWithError(context, deps, parsed.error, parsed.error.error);
    }
    const binding = session === undefined ? ensureBindingCookie(context, deps) : session.sessionKey;
    const id = mintCredential(CREDENTIAL_PREFIX.authorizationCode, deps.random).slice(
      CREDENTIAL_PREFIX.authorizationCode.length,
    );
    deps.repos.pendingAuthorizations.insert({
      id,
      sessionBindingHash: hashCredential(binding),
      parameters: toPendingParameters(parsed.value),
      expiresAt: deps.now() + PENDING_TTL_MS,
    });
    if (session === undefined) {
      return loginRedirect(context, deps, id);
    }
    context.header('Cache-Control', 'no-store');
    return context.redirect(`/oauth/authorize/${encodeURIComponent(id)}`, 302);
  };
}

export function pendingScopes(pending: PendingAuthorizationRecord): readonly Scope[] {
  return (pending.parameters['scope'] ?? '').split(' ').filter((entry) => isScope(entry));
}

/**
 * `GET /oauth/authorize/:id` (OAUTH-13, OAUTH-18): renders the consent page;
 * it never issues a code.
 */
export function createConsentPageHandler(
  deps: AuthorizeDeps,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const id = context.req.param('id');
    const pending = livePending(deps, id);
    if (pending === undefined) {
      return errorPage(
        context,
        new OAuthError('invalid_request', 'this authorization request has expired'),
        400,
      );
    }
    const session = await deps.sessions.resolve(context.req.raw);
    if (session === undefined) {
      return loginRedirect(context, deps, id);
    }
    if (!isBoundToBrowser(context, deps, session, pending)) {
      return errorPage(
        context,
        new OAuthError('access_denied', 'this authorization request belongs to another browser'),
        403,
      );
    }
    const { parameters } = pending;
    return context.html(
      renderConsentPage({
        requestId: id,
        csrfToken: session.csrfToken,
        clientName: parameters['client_name'] ?? '',
        redirectHost: parameters['redirect_host'] ?? '',
        mode: (parameters['client_mode'] ?? 'dcr') as ClientMode,
        loopbackOnly: parameters['loopback_only'] === '1',
        scopes: pendingScopes(pending),
      }),
      200,
      HTML_HEADERS,
    );
  };
}
