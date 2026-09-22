import { getCookie, setCookie } from 'hono/cookie';

import { renderErrorPage } from './consent-page.ts';
import {
  hashCredential,
  mintCredential,
  CREDENTIAL_PREFIX,
  type RandomSource,
} from './credentials.ts';
import { oauthErrorBody, type OAuthError } from './errors.ts';
import { HTML_HEADERS } from './html.ts';

import type { AuditSink } from './audit.ts';
import type { ClientIpResolver } from './client-ip.ts';
import type { ClientResolver } from './clients/resolve.ts';
import type { Clock } from './clock.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { PendingAuthorizationRecord } from './repositories/pending-authorizations.ts';
import type { CsrfGuard, OperatorSession, OperatorSessionResolver } from './session.ts';
import type { Context } from 'hono';

export interface AuthorizeDependencies {
  readonly publicUrl: string;
  readonly enableWriteScope: boolean;
  readonly resolver: ClientResolver;
  readonly repos: OAuthRepos;
  readonly sessions: OperatorSessionResolver;
  readonly csrf: CsrfGuard;
  readonly audit: AuditSink;
  readonly now: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
  /**
  30 per minute per session (spec §10.4).
  */
  readonly rateLimiter: RateLimiter;
  readonly clientIp: ClientIpResolver;
  readonly loginPath: string;
}

/**
 * OAUTH-17: a pending request lives ten minutes, long enough to log in.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

const BINDING_COOKIE = 'vg_authz';
const HOST_PREFIX = '__Host-';

/**
 * ID-16 applied to the binding cookie: `__Host-` and `Secure` unless the
 * deployment is plain-http loopback.
 */
export function bindingCookieName(publicUrl: string): string {
  return publicUrl.startsWith('https://') ? `${HOST_PREFIX}${BINDING_COOKIE}` : BINDING_COOKIE;
}

/**
 * The browser's binding cookie, minted and set when absent, so a request
 * started without a session can be claimed only by the same browser.
 */
export function ensureBindingCookie(context: Context, dependencies: AuthorizeDependencies): string {
  const name = bindingCookieName(dependencies.publicUrl);
  const existing = getCookie(context, name);
  if (existing !== undefined && existing.length > 0) {
    return existing;
  }
  const value = mintCredential(CREDENTIAL_PREFIX.authorizationCode, dependencies.random).slice(
    CREDENTIAL_PREFIX.authorizationCode.length,
  );
  setCookie(context, name, value, {
    httpOnly: true,
    secure: dependencies.publicUrl.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
    maxAge: PENDING_TTL_MS / 1000,
  });
  return value;
}

/**
 * Every key the current browser can prove: its session, its binding cookie.
 */
export function bindingHashes(
  context: Context,
  dependencies: AuthorizeDependencies,
  session: OperatorSession | undefined,
): readonly string[] {
  const cookie = getCookie(context, bindingCookieName(dependencies.publicUrl));
  return [
    ...(session === undefined ? [] : [hashCredential(session.sessionKey)]),
    ...(cookie === undefined || cookie.length === 0 ? [] : [hashCredential(cookie)]),
  ];
}

export function isBoundToBrowser(
  context: Context,
  dependencies: AuthorizeDependencies,
  session: OperatorSession | undefined,
  pending: PendingAuthorizationRecord,
): boolean {
  return bindingHashes(context, dependencies, session).includes(pending.sessionBindingHash);
}

export function rateLimitKey(
  context: Context,
  dependencies: AuthorizeDependencies,
  session: OperatorSession | undefined,
): string {
  const cookie = getCookie(context, bindingCookieName(dependencies.publicUrl));
  return (
    session?.sessionKey ??
    (cookie === undefined || cookie.length === 0 ? `ip:${dependencies.clientIp(context)}` : cookie)
  );
}

export function errorPage(context: Context, error: OAuthError, status: 400 | 403 | 429): Response {
  return context.html(renderErrorPage(error), status, HTML_HEADERS);
}

export function livePending(
  dependencies: AuthorizeDependencies,
  id: string,
): PendingAuthorizationRecord | undefined {
  const pending = dependencies.repos.pendingAuthorizations.find(id);
  return pending === undefined || pending.expiresAt <= dependencies.now() ? undefined : pending;
}

export function loginRedirect(
  context: Context,
  dependencies: AuthorizeDependencies,
  requestId: string,
): Response {
  const next = `/oauth/authorize/${encodeURIComponent(requestId)}`;
  context.header('Cache-Control', 'no-store');
  return context.redirect(`${dependencies.loginPath}?next=${encodeURIComponent(next)}`, 302);
}

/**
 * OAUTH-19 / OAUTH-20: the redirect back to the client always carries `iss`
 * (RFC 9207) and `state` when one was given.
 */
export function redirectToClient(
  context: Context,
  dependencies: AuthorizeDependencies,
  redirectUri: string,
  parameters: Readonly<Record<string, string | undefined>>,
): Response {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      target.searchParams.set(name, value);
    }
  }
  target.searchParams.set('iss', dependencies.publicUrl);
  context.header('Cache-Control', 'no-store');
  return context.redirect(target.href, 302);
}

export function redirectWithError(
  context: Context,
  dependencies: AuthorizeDependencies,
  target: { readonly redirectUri: string; readonly state: string | undefined },
  error: OAuthError,
): Response {
  return redirectToClient(context, dependencies, target.redirectUri, {
    ...oauthErrorBody(error),
    state: target.state,
  });
}

export function requestIdOf(context: Context): string | undefined {
  return context.req.header('x-request-id') ?? context.res.headers.get('x-request-id') ?? undefined;
}
