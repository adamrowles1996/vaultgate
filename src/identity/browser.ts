import { serialiseCookie, parseCookies } from './sessions.ts';
import { STATE_TTL_MS } from './state-cookie.ts';

import type { Form, IdentityContext, IdentityEnvironment } from './context.ts';
import type { IdentityServices } from './services.ts';
import type { BrowserState } from './state-cookie.ts';
import type { MiddlewareHandler } from 'hono';

export type { Form, IdentityContext, IdentityEnvironment } from './context.ts';

/**
ID-19, verbatim.
*/
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const MS_PER_SECOND = 1000;

/**
Every HTML page: strict CSP, never cached, no CORS (spec 03 OAUTH-37).
*/
export const pageHeaders: MiddlewareHandler<IdentityEnvironment> = async (context, next) => {
  await next();
  context.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  context.header('Cache-Control', 'no-store');
};

/**
The string fields of a form post; a body that is not a form reads as empty.
*/
export async function readForm(context: IdentityContext): Promise<Form> {
  const fields = new Map<string, string>();
  try {
    const data = await context.req.formData();
    for (const [name, value] of data) {
      if (typeof value === 'string') {
        fields.set(name, value);
      }
    }
  } catch {
    return fields;
  }
  return fields;
}

/**
A form field as text; absent reads as empty so every handler validates one shape.
*/
export function field(form: Form, name: string): string {
  return form.get(name) ?? '';
}

function readCookie(context: IdentityContext, name: string): string | undefined {
  return parseCookies(context.req.header('cookie') ?? null).get(name);
}

export function readState(
  context: IdentityContext,
  services: IdentityServices,
): BrowserState | undefined {
  const value = readCookie(context, services.cookiePolicy.stateCookieName);
  return services.stateCodec.decode(value, services.clock());
}

export function setStateCookie(
  context: IdentityContext,
  services: IdentityServices,
  state: Omit<BrowserState, 'expiresAt'>,
): void {
  const { cookiePolicy, stateCodec, clock } = services;
  const value = stateCodec.encode({ ...state, expiresAt: clock() + STATE_TTL_MS });
  const cookie = serialiseCookie(cookiePolicy.stateCookieName, value, {
    isSecure: cookiePolicy.isSecure,
    maxAgeSeconds: STATE_TTL_MS / MS_PER_SECOND,
  });
  context.header('Set-Cookie', cookie, { append: true });
}

export function clearStateCookie(context: IdentityContext, services: IdentityServices): void {
  const { cookiePolicy } = services;
  const cookie = serialiseCookie(cookiePolicy.stateCookieName, '', {
    isSecure: cookiePolicy.isSecure,
    maxAgeSeconds: 0,
  });
  context.header('Set-Cookie', cookie, { append: true });
}

export function setSessionCookie(
  context: IdentityContext,
  services: IdentityServices,
  sessionId: string,
): void {
  const { cookiePolicy, absoluteSessionTtlMs } = services;
  const cookie = serialiseCookie(cookiePolicy.sessionCookieName, sessionId, {
    isSecure: cookiePolicy.isSecure,
    maxAgeSeconds: Math.floor(absoluteSessionTtlMs / MS_PER_SECOND),
  });
  context.header('Set-Cookie', cookie, { append: true });
}

export function clearSessionCookie(context: IdentityContext, services: IdentityServices): void {
  const { cookiePolicy } = services;
  const cookie = serialiseCookie(cookiePolicy.sessionCookieName, '', {
    isSecure: cookiePolicy.isSecure,
    maxAgeSeconds: 0,
  });
  context.header('Set-Cookie', cookie, { append: true });
}

/**
Reads the session cookie once per request and exposes it as `session` (ID-14).
*/
export function attachSession(services: IdentityServices): MiddlewareHandler<IdentityEnvironment> {
  return async (context, next) => {
    const sessionId = readCookie(context, services.cookiePolicy.sessionCookieName);
    context.set('session', services.sessions.resolve(sessionId));
    await next();
  };
}
