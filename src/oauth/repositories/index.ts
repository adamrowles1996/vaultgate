import {
  type AuthorizationCodesRepo,
  createAuthorizationCodesRepo,
} from './authorization-codes.ts';
import { type CimdCacheRepo, createCimdCacheRepo } from './cimd-cache.ts';
import { type ClientsRepo, createClientsRepo } from './clients.ts';
import { type ConsentsRepo, createConsentsRepo } from './consents.ts';
import {
  createPendingAuthorizationsRepo,
  type PendingAuthorizationsRepo,
} from './pending-authorizations.ts';
import { createTokensRepo, type TokensRepo } from './tokens.ts';

import type { DatabaseSync } from 'node:sqlite';

export interface OAuthRepos {
  readonly db: DatabaseSync;
  readonly clients: ClientsRepo;
  readonly cimdCache: CimdCacheRepo;
  readonly consents: ConsentsRepo;
  readonly authorizationCodes: AuthorizationCodesRepo;
  readonly tokens: TokensRepo;
  readonly pendingAuthorizations: PendingAuthorizationsRepo;
}

export function createOAuthRepos(database: DatabaseSync): OAuthRepos {
  return {
    db: database,
    clients: createClientsRepo(database),
    cimdCache: createCimdCacheRepo(database),
    consents: createConsentsRepo(database),
    authorizationCodes: createAuthorizationCodesRepo(database),
    tokens: createTokensRepo(database),
    pendingAuthorizations: createPendingAuthorizationsRepo(database),
  };
}
