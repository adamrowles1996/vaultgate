import type { IdentityContext } from '../identity/context.ts';
import type { Guards } from '../identity/guards.ts';

/**
 * Every OAuth handler runs under the identity middleware, so the request
 * context carries `session` (ID-21) and the ID-18 guards apply unchanged.
 */
export type OAuthContext = IdentityContext;

export type OAuthHandler = (context: OAuthContext) => Promise<Response>;

export type ClientIpResolver = (context: OAuthContext) => string;

const UNKNOWN_ADDRESS = 'unknown';

/**
 * OPS-6: the proxy-aware address from the identity guards, or a fixed key
 * when the listener reports none.
 */
export function clientIpResolver(guards: Pick<Guards, 'clientInfo'>): ClientIpResolver {
  return (context) => guards.clientInfo(context).ip ?? UNKNOWN_ADDRESS;
}
