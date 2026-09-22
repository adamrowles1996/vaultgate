import {
  createAuthorizationCodesRepo as createAuthorizationCodesRepo,
  type AuthorizationCodesRepo as AuthorizationCodesRepo,
} from './authorization-codes.ts';
import {
  createCimdCacheRepo as createCimdCacheRepo,
  type CimdCacheRepo as CimdCacheRepo,
} from './cimd-cache.ts';
import {
  createClientsRepo as createClientsRepo,
  type ClientsRepo as ClientsRepo,
} from './clients.ts';
import {
  createConsentsRepo as createConsentsRepo,
  type ConsentsRepo as ConsentsRepo,
} from './consents.ts';
import {
  createPendingAuthorizationsRepo as createPendingAuthorizationsRepo,
  type PendingAuthorizationsRepo,
} from './pending-authorizations.ts';
import { createTokensRepo as createTokensRepo, type TokensRepo } from './tokens.ts';

import type { SqlStore } from './sql-store.ts';

export interface OAuthRepos {
  readonly store: SqlStore;
  readonly clients: ClientsRepo;
  readonly cimdCache: CimdCacheRepo;
  readonly consents: ConsentsRepo;
  readonly authorizationCodes: AuthorizationCodesRepo;
  readonly tokens: TokensRepo;
  readonly pendingAuthorizations: PendingAuthorizationsRepo;
}

export function createOAuthRepos(store: SqlStore): OAuthRepos {
  return {
    store,
    clients: createClientsRepo(store),
    cimdCache: createCimdCacheRepo(store),
    consents: createConsentsRepo(store),
    authorizationCodes: createAuthorizationCodesRepo(store),
    tokens: createTokensRepo(store),
    pendingAuthorizations: createPendingAuthorizationsRepo(store),
  };
}
