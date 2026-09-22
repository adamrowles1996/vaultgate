import { parseAuthorizationRequest, toPendingParameters } from './authorize-request.ts';
import {
  type AuthorizeDependencies,
  ensureBindingCookie,
  errorPage,
  isBoundToBrowser,
  livePending,
  loginRedirect,
  PENDING_TTL_MS,
  rateLimitKey,
  redirectWithError,
  type LivePending,
} from './authorize-shared.ts';
import { renderConsentPage } from './consent-page.ts';
import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { OAuthError } from './errors.ts';
import { isScope, type Scope } from './scopes.ts';

import type { OAuthContext, OAuthHandler } from './request-context.ts';

function tooManyRequests(
  context: Parameters<OAuthHandler>[0],
  retryAfterSeconds: number,
): Response {
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
export function createAuthorizeHandler(dependencies: AuthorizeDependencies): OAuthHandler {
  return async (context) => {
    const session = context.get('session');
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
      session === undefined ? ensureBindingCookie(context, dependencies) : session.idHash;
    const id = mintCredential(CREDENTIAL_PREFIX.authorizationCode, dependencies.random).slice(
      CREDENTIAL_PREFIX.authorizationCode.length,
    );
    dependencies.repos.pendingAuthorizations.insert({
      id,
      sessionBindingHash: hashCredential(binding),
      parameters: toPendingParameters(parsed.value),
      expiresAt: dependencies.now() + PENDING_TTL_MS,
    });
    return session === undefined
      ? loginRedirect(context, id)
      : context.redirect(`/oauth/authorize/${encodeURIComponent(id)}`, 302);
  };
}

export function pendingScopes(pending: LivePending): readonly Scope[] {
  return pending.parameters.scope.split(' ').filter((entry) => isScope(entry));
}

export type ConsentPageHandler = (context: OAuthContext, id: string) => Promise<Response>;

/**
 * `GET /oauth/authorize/:id` (OAUTH-13, OAUTH-18): renders the consent page;
 * it never issues a code.
 */
export function createConsentPageHandler(dependencies: AuthorizeDependencies): ConsentPageHandler {
  return (context, id) => {
    const pending = livePending(dependencies, id);
    if (pending === undefined) {
      return Promise.resolve(
        errorPage(
          context,
          new OAuthError('invalid_request', 'this authorization request has expired'),
          400,
        ),
      );
    }
    const session = context.get('session');
    if (session === undefined) {
      return Promise.resolve(loginRedirect(context, id));
    }
    if (!isBoundToBrowser(context, dependencies, session, pending)) {
      return Promise.resolve(
        errorPage(
          context,
          new OAuthError('access_denied', 'this authorization request belongs to another browser'),
          403,
        ),
      );
    }
    const { parameters } = pending;
    const view = {
      requestId: id,
      csrfToken: session.csrfToken,
      clientName: parameters.client_name,
      redirectHost: parameters.redirect_host,
      mode: parameters.client_mode,
      loopbackOnly: parameters.loopback_only === '1',
      scopes: pendingScopes(pending),
    };
    return Promise.resolve(context.html(renderConsentPage(view)));
  };
}
