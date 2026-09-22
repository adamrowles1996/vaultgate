import { getCookie, setCookie } from 'hono/cookie';

import { hashCredential, mintCredential, CREDENTIAL_PREFIX, type RandomSource } from './credentials.ts';
import { HTML_HEADERS } from './html.ts';
import { renderErrorPage } from './consent-page.ts';
import { oauthErrorBody, type OAuthError } from './errors.ts';

import type { Context } from 'hono';
import type { AuditSink } from './audit.ts';
import type { ClientIpResolver } from './client-ip.ts';
import type { ClientResolver } from './clients/resolve.ts';
import type { Clock } from './clock.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { PendingAuthorizationRecord } from './repositories/pending-authorizations.ts';
import type { CsrfGuard, OperatorSession, OperatorSessionResolver } from './session.ts';

export interface AuthorizeDeps {
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
export function ensureBindingCookie(context: Context, deps: AuthorizeDeps): string {
  const name = bindingCookieName(deps.publicUrl);
  const existing = getCookie(context, name);
  if (existing !== undefined && existing.length > 0) {
    return existing;
  }
  const value = mintCredential(CREDENTIAL_PREFIX.authorizationCode, deps.random).slice(
    CREDENTIAL_PREFIX.authorizationCode.length,
  );
  setCookie(context, name, value, {
    httpOnly: true,
    secure: deps.publicUrl.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
    maxAge: PENDING_TTL_MS / 1000,
  });
  return value;
}

/**
 * Every key the current browser can prove: its session, its binding cookie.
 */
export function bindingHashes(context: Context, deps: AuthorizeDeps, session: OperatorSession | undefined): readonly string[] {
  const cookie = getCookie(context, bindingCookieName(deps.publicUrl));
  return [
    ...(session === undefined ? [] : [hashCredential(session.sessionKey)]),
    ...(cookie === undefined || cookie.length === 0 ? [] : [hashCredential(cookie)]),
  ];
}

export function isBoundToBrowser(
  context: Context,
  deps: AuthorizeDeps,
  session: OperatorSession | undefined,
  pending: PendingAuthorizationRecord,
): boolean {
  return bindingHashes(context, deps, session).includes(pending.sessionBindingHash);
}

export function rateLimitKey(context: Context, deps: AuthorizeDeps, session: OperatorSession | undefined): string {
  const cookie = getCookie(context, bindingCookieName(deps.publicUrl));
  return session?.sessionKey ?? (cookie === undefined || cookie.length === 0 ? `ip:${deps.clientIp(context.req.raw)}` : cookie);
}

export function errorPage(context: Context, error: OAuthError, status: 400 | 403 | 429): Response {
  return context.html(renderErrorPage(error), status, HTML_HEADERS);
}

export function livePending(deps: AuthorizeDeps, id: string): PendingAuthorizationRecord | undefined {
  const pending = deps.repos.pendingAuthorizations.find(id);
  return pending === undefined || pending.expiresAt <= deps.now() ? undefined : pending;
}

export function loginRedirect(context: Context, deps: AuthorizeDeps, requestId: string): Response {
  const next = `/oauth/authorize/${encodeURIComponent(requestId)}`;
  context.header('Cache-Control', 'no-store');
  return context.redirect(`${deps.loginPath}?next=${encodeURIComponent(next)}`, 302);
}

/**
 * OAUTH-19 / OAUTH-20: the redirect back to the client always carries `iss`
 * (RFC 9207) and `state` when one was given.
 */
export function redirectToClient(
  context: Context,
  deps: AuthorizeDeps,
  redirectUri: string,
  parameters: Readonly<Record<string, string | undefined>>,
): Response {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      target.searchParams.set(name, value);
    }
  }
  target.searchParams.set('iss', deps.publicUrl);
  context.header('Cache-Control', 'no-store');
  return context.redirect(target.href, 302);
}

export function redirectWithError(
  context: Context,
  deps: AuthorizeDeps,
  target: { readonly redirectUri: string; readonly state: string | undefined },
  error: OAuthError,
): Response {
  return redirectToClient(context, deps, target.redirectUri, { ...oauthErrorBody(error), state: target.state });
}

export function requestIdOf(context: Context): string | undefined {
  return context.req.header('x-request-id') ?? context.res.headers.get('x-request-id') ?? undefined;
}
