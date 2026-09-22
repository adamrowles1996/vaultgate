import { fail, ok, type Result } from '../../result.ts';
import { OAuthError } from '../errors.ts';
import { isLoopbackRedirect, isRegisteredRedirect } from '../redirect-uri.ts';

import type { Clock } from '../clock.ts';
import type { CimdFetcher } from './cimd.ts';
import type { ClientMode, ClientRecord, ClientsRepo } from '../repositories/clients.ts';

export interface ResolvedClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly mode: ClientMode;
  readonly redirectUris: readonly string[];
  /**
  T7: every registered redirect is loopback, so the name proves nothing.
  */
  readonly loopbackOnly: boolean;
}

export interface ClientResolverOptions {
  readonly preregistered: readonly ClientRecord[];
  readonly cimd: CimdFetcher;
  readonly clients: ClientsRepo;
  readonly now: Clock;
  readonly newId: () => string;
}

export interface ClientResolver {
  /**
   * §3.3: pre-registered, then CIMD, then DCR. `redirectUri`, when known,
   * forces a CIMD refetch if the cached document does not list it (T22).
   */
  resolve(clientId: string, redirectUri?: string): Promise<Result<ResolvedClient, OAuthError>>;
}

/**
 * A CIMD identifier is an `https://` URL with a non-empty path.
 */
export function isCimdClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname !== '/';
  } catch {
    return false;
  }
}

function toResolved(record: ClientRecord): ResolvedClient {
  return {
    clientId: record.clientId,
    clientName: record.clientName ?? record.clientId,
    mode: record.mode,
    redirectUris: record.redirectUris,
    loopbackOnly: record.redirectUris.every((uri) => isLoopbackRedirect(uri)),
  };
}

function unknownClient(): OAuthError {
  return new OAuthError('invalid_client', 'unknown client_id');
}

export function createClientResolver(options: ClientResolverOptions): ClientResolver {
  const preregistered = new Map(options.preregistered.map((client) => [client.clientId, client]));

  async function resolveCimd(
    clientId: string,
    redirectUri: string | undefined,
  ): Promise<Result<ResolvedClient, OAuthError>> {
    let fetched = await options.cimd.fetch(clientId);
    if (
      redirectUri !== undefined &&
      fetched.ok &&
      !isRegisteredRedirect(redirectUri, fetched.value.redirect_uris)
    ) {
      fetched = await options.cimd.fetch(clientId, { force: true });
    }
    if (!fetched.ok) {
      return fail(fetched.error);
    }
    const existing = options.clients.findByClientId(clientId);
    const record: ClientRecord = {
      id: existing?.id ?? options.newId(),
      clientId,
      mode: 'cimd',
      clientName: fetched.value.client_name,
      redirectUris: fetched.value.redirect_uris,
      metadata: fetched.value,
      createdAt: existing?.createdAt ?? options.now(),
      revokedAt: undefined,
    };
    options.clients.upsert(record);
    return ok(toResolved(record));
  }

  return {
    async resolve(clientId, redirectUri) {
      const configured = preregistered.get(clientId);
      if (configured !== undefined) {
        return ok(toResolved(configured));
      }
      if (isCimdClientId(clientId)) {
        return resolveCimd(clientId, redirectUri);
      }
      const dynamic = options.clients.findByClientId(clientId);
      return dynamic?.mode !== 'dcr' || dynamic.revokedAt !== undefined
        ? fail(unknownClient())
        : ok(toResolved(dynamic));
    },
  };
}
