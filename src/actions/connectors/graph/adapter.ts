/**
 * The token service of the `graph` (spec §14.3) and `oauth2` (§14.3a)
 * credential adapters: credential modes of the `http` connector rather than
 * connectors of their own, so `http_request` on such a target behaves
 * exactly as on a `header` one once a token is in hand. One service serves
 * both modes through the mode's exchange plan (`./exchange.ts`): it obtains
 * the token (ACT-82, ACT-125, ACT-126), writes back a refresh token the
 * endpoint changed before the request runs (ACT-83, ACT-127), keeps the
 * token in the one in-process cache (ACT-129), and hands every secret it
 * touches to the call's scrub table (ACT-51, ACT-128).
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { createTokenCache } from './cache.ts';
import { type ExchangePlan, exchangePlan, type TokenCredential } from './exchange.ts';
import { requestToken } from './token.ts';

import type { TokenGrant } from './token-response.ts';
import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { InjectedValues } from '../../scrub.ts';
import type { RunSupport } from '../connector.ts';

export interface TokenDependencies {
  readonly transport: PinnedFetch;
  readonly now: () => number;
  readonly version: string;
}

/**
The part of an `http` run context the service reads; the credential is narrowed to a token mode.
*/
export interface TokenContext {
  readonly credential: TokenCredential;
  readonly injected: InjectedValues;
  readonly support: RunSupport;
  readonly signal: AbortSignal;
}

export interface TokenService {
  /**
  An access token for the call; `isRetry` discards a cached one first (the 401 path of ACT-129).
  */
  accessToken(context: TokenContext, isRetry: boolean): Promise<Result<string, ActionError>>;
}

function held(injected: InjectedValues, field: string | undefined): string | undefined {
  return field === undefined ? undefined : injected.value(field)?.toString('utf8');
}

/**
 * The token endpoint's answer, or the reason there is none;
 * `credential_unavailable` when the vault held no value. The endpoint's
 * host is resolved and validated here, for this exchange (ACT-55, ACT-56).
 */
async function obtain(
  dependencies: TokenDependencies,
  context: TokenContext,
  plan: ExchangePlan,
): Promise<Result<TokenGrant, ActionError>> {
  const isRefreshing = plan.grant === 'refresh_token';
  const clientSecret = held(context.injected, plan.secretField);
  const refreshToken = isRefreshing ? held(context.injected, plan.refreshTokenField) : undefined;
  if (clientSecret === undefined || (isRefreshing && refreshToken === undefined)) {
    return fail(new ActionError('credential_unavailable'));
  }
  const pinned = await context.support.resolve({ host: plan.host, tls: true });
  if (!pinned.ok) {
    return pinned;
  }
  return requestToken(dependencies.transport, {
    plan,
    clientSecret,
    refreshToken,
    address: pinned.value.address,
    signal: context.signal,
    version: dependencies.version,
  });
}

/**
 * ACT-83, ACT-127: a refresh token the endpoint changed is written back
 * before the destination request is made, so a write-back that fails costs
 * one refused call rather than a credential the operator can no longer use.
 * One equal to the token the call holds (an endpoint that echoes it, or
 * never rotates) writes nothing.
 */
async function writeBack(
  context: TokenContext,
  plan: ExchangePlan,
  grant: TokenGrant,
): Promise<Result<void, ActionError>> {
  const field = plan.refreshTokenField;
  const returned = grant.refreshToken;
  if (field === undefined || returned === undefined || returned === held(context.injected, field)) {
    return ok(undefined);
  }
  context.support.capture(field, Buffer.from(returned, 'utf8'));
  return context.support.rotate(field, returned);
}

function captured(context: TokenContext, plan: ExchangePlan, token: string): string {
  context.support.capture(plan.accessTokenField, Buffer.from(token, 'utf8'));
  return token;
}

export function createTokenService(dependencies: TokenDependencies): TokenService {
  const cache = createTokenCache();
  return {
    async accessToken(context, isRetry) {
      const { id, revision } = context.support.target;
      const plan = exchangePlan(context.credential);
      if (isRetry) {
        cache.invalidate(id);
      }
      const cached = cache.get(id, revision, dependencies.now());
      if (cached !== undefined) {
        return ok(captured(context, plan, cached));
      }
      const grant = await obtain(dependencies, context, plan);
      if (!grant.ok) {
        return grant;
      }
      const token = captured(context, plan, grant.value.accessToken);
      const written = await writeBack(context, plan, grant.value);
      if (!written.ok) {
        return written;
      }
      const expiresAt = dependencies.now() + grant.value.expiresInMs;
      cache.set(id, { revision, token, expiresAt });
      return ok(token);
    },
  };
}
