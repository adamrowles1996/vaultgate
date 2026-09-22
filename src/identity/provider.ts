import type { SessionState } from './session-manager.ts';

type AuthOutcome =
  | { readonly kind: 'authenticated'; readonly operatorId: string }
  | { readonly kind: 'redirect'; readonly location: string };

/**
 * Spec §4.7. The OAuth authorize flow calls `authenticate` with whatever
 * session the cookie resolved to and acts only on the outcome (ID-21).
 */
export interface IdentityProvider {
  readonly kind: 'local' | 'oidc' | 'passkey';
  authenticate(request: Request, session: SessionState | undefined): Promise<AuthOutcome>;
}

/**
A path on this origin only: no scheme, no protocol-relative `//host`, no backslash tricks.
*/
export function safeNextPath(candidate: string | undefined, fallback = '/account'): string {
  if (candidate === undefined || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return fallback;
  }
  return candidate.includes('\\') ? fallback : candidate;
}

export function loginLocation(request: Request): string {
  const url = new URL(request.url);
  const next = safeNextPath(`${url.pathname}${url.search}`);
  return `/login?next=${encodeURIComponent(next)}`;
}

export function createLocalProvider(): IdentityProvider {
  return {
    kind: 'local',
    authenticate: (request, session) =>
      Promise.resolve(
        session === undefined
          ? { kind: 'redirect', location: loginLocation(request) }
          : { kind: 'authenticated', operatorId: session.operatorId },
      ),
  };
}
