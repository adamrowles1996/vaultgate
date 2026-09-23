/**
 * The `graph` credential adapter (spec §14.3): a credential mode of the
 * `http` connector rather than a connector of its own, so `http_request` on
 * a graph target behaves exactly as it does on a bearer one once a token is
 * in hand. It obtains that token (ACT-82), writes back a rotated refresh
 * token before the request runs (ACT-83), and hands every secret it touches
 * to the call's scrub table (ACT-51).
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { createTokenCache } from './cache.ts';
import { type GraphCredential, GRAPH_TOKEN_HOST } from './document.ts';
import { requestToken, type TokenGrant } from './token.ts';

import type { PinnedFetch } from '../../../net/pinned-https.ts';
import type { InjectedValues } from '../../scrub.ts';
import type { RunSupport } from '../connector.ts';

/**
The field name the access token is redacted under: `[redacted:graph.access_token]`.
*/
export const ACCESS_TOKEN_FIELD = 'graph.access_token';

export interface GraphDependencies {
  readonly transport: PinnedFetch;
  readonly now: () => number;
  readonly version: string;
}

/**
The part of an `http` run context the adapter reads; the credential is narrowed to the graph mode.
*/
export interface GraphContext {
  readonly credential: GraphCredential;
  readonly injected: InjectedValues;
  readonly support: RunSupport;
  readonly signal: AbortSignal;
}

export interface GraphTokens {
  /**
  An access token for the call; `isRetry` discards a cached one first (the 401 path of ACT-82).
  */
  accessToken(context: GraphContext, isRetry: boolean): Promise<Result<string, ActionError>>;
}

function held(injected: InjectedValues, field: string): string | undefined {
  return injected.value(field)?.toString('utf8');
}

/**
The token endpoint's answer, or the reason there is none; `credential_unavailable` when the vault held no value.
*/
async function obtain(
  dependencies: GraphDependencies,
  context: GraphContext,
): Promise<Result<TokenGrant, ActionError>> {
  const { credential } = context;
  const isRotating = credential.grant === 'refresh_token';
  const clientSecret = held(context.injected, credential.secret_field);
  const refreshToken =
    isRotating && credential.refresh_token_field !== undefined
      ? held(context.injected, credential.refresh_token_field)
      : undefined;
  if (clientSecret === undefined || (isRotating && refreshToken === undefined)) {
    return fail(new ActionError('credential_unavailable'));
  }
  const pinned = await context.support.resolve({ host: GRAPH_TOKEN_HOST, tls: true });
  if (!pinned.ok) {
    return pinned;
  }
  return requestToken(dependencies.transport, {
    credential,
    clientSecret,
    refreshToken,
    address: pinned.value.address,
    signal: context.signal,
    version: dependencies.version,
  });
}

/**
 * ACT-83: a rotated refresh token is written back before the Graph request
 * is made, so a write-back that fails costs one refused call rather than a
 * credential the operator can no longer use.
 */
async function writeBack(
  context: GraphContext,
  grant: TokenGrant,
): Promise<Result<void, ActionError>> {
  const field = context.credential.refresh_token_field;
  if (field === undefined || grant.rotatedRefreshToken === undefined) {
    return ok(undefined);
  }
  context.support.capture(field, Buffer.from(grant.rotatedRefreshToken, 'utf8'));
  return context.support.rotate(field, grant.rotatedRefreshToken);
}

function captured(context: GraphContext, token: string): string {
  context.support.capture(ACCESS_TOKEN_FIELD, Buffer.from(token, 'utf8'));
  return token;
}

export function createGraphTokens(dependencies: GraphDependencies): GraphTokens {
  const cache = createTokenCache();
  return {
    async accessToken(context, isRetry) {
      const { id, revision } = context.support.target;
      if (isRetry) {
        cache.invalidate(id);
      }
      const cached = cache.get(id, revision, dependencies.now());
      if (cached !== undefined) {
        return ok(captured(context, cached));
      }
      const grant = await obtain(dependencies, context);
      if (!grant.ok) {
        return grant;
      }
      const written = await writeBack(context, grant.value);
      if (!written.ok) {
        return written;
      }
      const expiresAt = dependencies.now() + grant.value.expiresInMs;
      cache.set(id, { revision, token: grant.value.accessToken, expiresAt });
      return ok(captured(context, grant.value.accessToken));
    },
  };
}
