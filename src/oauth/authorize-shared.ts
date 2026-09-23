import { getCookie, setCookie } from 'hono/cookie';

import { safeNextPath } from '../identity/provider.ts';

import { parsePendingParameters, type PendingParameters } from './authorize-request.ts';
import { renderErrorPage } from './consent-page.ts';
import {
  CREDENTIAL_PREFIX,
  hashCredential,
  mintCredential,
  type RandomSource,
} from './credentials.ts';
import { oauthErrorBody, type OAuthError } from './errors.ts';

import type { OAuthAuditSink } from './audit.ts';
import type { Guards } from '../identity/guards.ts';
import type { SessionState } from '../identity/session-manager.ts';
import type { ClientResolver } from './clients/resolve.ts';
import type { Clock } from './clock.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { ClientIpResolver, OAuthContext } from './request-context.ts';

export interface AuthorizeDependencies {
  readonly publicUrl: string;
  readonly enableWriteScope: boolean;
  readonly resolver: ClientResolver;
  readonly repos: OAuthRepos;
  /**
  ID-18 origin and synchroniser-token checks, shared with the identity pages.
  */
  readonly guards: Guards;
  readonly audit: OAuthAuditSink;
  readonly now: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
  /**
  30 per minute per session (spec §10.4).
  */
  readonly rateLimiter: RateLimiter;
  readonly clientIp: ClientIpResolver;
}

/**
 * OAUTH-17: a pending request lives ten minutes, long enough to log in.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

const BINDING_COOKIE = 'vg_authz';
const HOST_PREFIX = '__Host-';
const SECOND_MS = 1000;

/**
 * ID-16 applied to the binding cookie: `__Host-` and `Secure` unless the
 * deployment is plain-http loopback.
 */
function bindingCookieName(publicUrl: string): string {
  return publicUrl.startsWith('https://') ? `${HOST_PREFIX}${BINDING_COOKIE}` : BINDING_COOKIE;
}

function bindingCookie(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
): string | undefined {
  const value = getCookie(context, bindingCookieName(dependencies.publicUrl));
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * The browser's binding cookie, minted and set when absent, so a request
 * started without a session can be claimed only by the same browser.
 */
export function ensureBindingCookie(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
): string {
  const existing = bindingCookie(context, dependencies);
  if (existing !== undefined) {
    return existing;
  }
  const value = mintCredential(CREDENTIAL_PREFIX.authorizationCode, dependencies.random).slice(
    CREDENTIAL_PREFIX.authorizationCode.length,
  );
  setCookie(context, bindingCookieName(dependencies.publicUrl), value, {
    httpOnly: true,
    secure: dependencies.publicUrl.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
    maxAge: PENDING_TTL_MS / SECOND_MS,
  });
  return value;
}

/**
 * Every key the signed-in browser can prove: its session, and the binding
 * cookie it may have received before logging in.
 */
function bindingHashes(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
  session: SessionState,
): readonly string[] {
  const cookie = bindingCookie(context, dependencies);
  const hashes = [hashCredential(session.idHash)];
  if (cookie !== undefined) {
    hashes.push(hashCredential(cookie));
  }
  return hashes;
}

export function isBoundToBrowser(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
  session: SessionState,
  pending: LivePending,
): boolean {
  return bindingHashes(context, dependencies, session).includes(pending.sessionBindingHash);
}

/**
 * §10.4: a signed-in browser is limited by its session, anything else by its
 * address. The binding cookie is client-chosen and never a key: rotating it
 * must not buy a fresh allowance.
 */
export function rateLimitKey(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
  session: SessionState | undefined,
): string {
  return session?.idHash ?? `ip:${dependencies.clientIp(context)}`;
}

export function errorPage(
  context: OAuthContext,
  error: OAuthError,
  status: 400 | 403 | 429,
): Response {
  return context.html(renderErrorPage(error), status);
}

export interface LivePending {
  readonly id: string;
  readonly sessionBindingHash: string;
  readonly parameters: PendingParameters;
}

/**
 * A pending request that exists, has not expired and reads back intact.
 */
export function livePending(
  dependencies: AuthorizeDependencies,
  id: string,
): LivePending | undefined {
  const pending = dependencies.repos.pendingAuthorizations.find(id);
  if (pending === undefined || pending.expiresAt <= dependencies.now()) {
    return undefined;
  }
  const parameters = parsePendingParameters(pending.parameters);
  return parameters === undefined
    ? undefined
    : { id: pending.id, sessionBindingHash: pending.sessionBindingHash, parameters };
}

/**
 * OAUTH-17: `/login?next=/oauth/authorize/<id>`; the parameters stay
 * server-side and never ride along in `next`.
 */
export function loginRedirect(context: OAuthContext, requestId: string): Response {
  const next = safeNextPath(`/oauth/authorize/${encodeURIComponent(requestId)}`);
  return context.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
}

/**
 * OAUTH-19 / OAUTH-20: the redirect back to the client always carries `iss`
 * (RFC 9207) and `state` when one was given.
 */
export function redirectToClient(
  context: OAuthContext,
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
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
  target: { readonly redirectUri: string; readonly state: string | undefined },
  error: OAuthError,
): Response {
  return redirectToClient(context, dependencies, target.redirectUri, {
    ...oauthErrorBody(error),
    state: target.state,
  });
}
