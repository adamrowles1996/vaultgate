import type { SessionState } from './session-manager.ts';
import type { Context } from 'hono';
import type { RequestIdVariables } from 'hono/request-id';

/**
 * Request-scoped types shared by the browser helpers, the guards and the
 * route handlers. A leaf module so none of them depend on each other.
 */
export type IdentityVariables = RequestIdVariables & { session: SessionState | undefined };

export interface IdentityEnvironment {
  readonly Variables: IdentityVariables;
}

export type IdentityContext = Context<IdentityEnvironment>;

/**
Resolves the socket address; injected because tests run without a socket (ARCH-5).
*/
export type ClientAddressResolver = (context: IdentityContext) => string | undefined;

export type Form = ReadonlyMap<string, string>;
