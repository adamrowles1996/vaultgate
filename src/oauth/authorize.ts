import { parseAuthorizationRequest, toPendingParameters } from './authorize-request.ts';
import {
  type AuthorizeDependencies as AuthorizeDependencies,
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

import type { ClientMode } from './repositories/clients.ts';
import type { PendingAuthorizationRecord } from './repositories/pending-authorizations.ts';
import type { Context } from 'hono';

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
export function createAuthorizeHandler(
  dependencies: AuthorizeDependencies,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const session = await dependencies.sessions.resolve(context.req.raw);
    const limit = dependencies.rateLimiter.take(rateLimitKey(context, dependencies, session));
    if (!limit.allowed) {
      return tooManyRequests(context, limit.retryAfterSeconds);
    }
    const parsed = await parseAuthorizationRequest(new URL(context.req.url), dependencies);
    if (!parsed.ok) {
      return parsed.error.redirect === undefined
        ? errorPage(context, parsed.error.oauthError, 400)
        : redirectWithError(context, dependencies, parsed.error.redirect, parsed.error.oauthError);
    }
    const binding =
      session === undefined ? ensureBindingCookie(context, dependencies) : session.sessionKey;
    const id = mintCredential(CREDENTIAL_PREFIX.authorizationCode, dependencies.random).slice(
      CREDENTIAL_PREFIX.authorizationCode.length,
    );
    dependencies.repos.pendingAuthorizations.insert({
      id,
      sessionBindingHash: hashCredential(binding),
      parameters: toPendingParameters(parsed.value),
      expiresAt: dependencies.now() + PENDING_TTL_MS,
    });
    if (session === undefined) {
      return loginRedirect(context, dependencies, id);
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
  dependencies: AuthorizeDependencies,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const id = context.req.param('id') ?? '';
    const pending = livePending(dependencies, id);
    if (pending === undefined) {
      return errorPage(
        context,
        new OAuthError('invalid_request', 'this authorization request has expired'),
        400,
      );
    }
    const session = await dependencies.sessions.resolve(context.req.raw);
    if (session === undefined) {
      return loginRedirect(context, dependencies, id);
    }
    if (!isBoundToBrowser(context, dependencies, session, pending)) {
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
