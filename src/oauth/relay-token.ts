/**
 * Access tokens the credential relay hands to admitted tailnet nodes
 * (RELAY-14…16). The relay is the one holder of the grant: it mints each
 * access token directly under the newest live consent of one configured
 * client, exactly as the token endpoint mints one (OAUTH-24), carrying every
 * scope in the registry so the whole tool surface is reachable, new tools
 * included (only the scopes the deployment enables apply at use), and never a
 * refresh token, so many short-lived sandboxes can use `/mcp` at once without
 * any of them rotating a refresh family (OAUTH-25).
 */
import { SCOPES } from '../scopes/registry.ts';

import { type Clock, toSeconds } from './clock.ts';
import {
  CREDENTIAL_PREFIX,
  hashCredential,
  mintCredential,
  type RandomSource,
} from './credentials.ts';
import { canonicalResource } from './metadata.ts';

import type { OAuthAuditSink } from './audit.ts';
import type { OAuthRepos } from './repositories/index.ts';

/**
The first characters of the token hash, as `/mcp` records them (MCP-13).
*/
const TOKEN_ID_LENGTH = 12;

export interface RelayTokenIssuerOptions {
  readonly repos: Pick<OAuthRepos, 'tokens' | 'clients' | 'consents'>;
  readonly publicUrl: string;
  /**
  The configured `VAULTGATE_RELAY_MCP_CLIENT`.
  */
  readonly clientId: string;
  readonly accessTokenTtlMs: number;
  readonly audit: OAuthAuditSink;
  readonly now: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
}

/**
The node the token is issued to, as the relay admitted it (RELAY-3).
*/
export interface RelayTokenRequest {
  readonly node: string;
  readonly ip: string;
}

export interface RelayToken {
  readonly object: 'token';
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly scope: string;
  readonly resource: string;
}

export interface IssuedRelayToken {
  readonly clientId: string;
  /**
  First 12 hex characters of the token's SHA-256, never the token.
  */
  readonly tokenId: string;
  readonly token: RelayToken;
}

/**
The issued token, or `undefined` when the client is unknown or revoked or has no live consent (RELAY-15).
*/
export type IssueRelayToken = (request: RelayTokenRequest) => IssuedRelayToken | undefined;

export function createRelayTokenIssuer(options: RelayTokenIssuerOptions): IssueRelayToken {
  const resource = canonicalResource(options.publicUrl);
  return (request) => {
    const { repos, clientId } = options;
    const client = repos.clients.findByClientId(clientId);
    const consent =
      client === undefined || client.revokedAt !== undefined
        ? undefined
        : repos.consents.findNewestActiveForClient(clientId);
    if (consent === undefined) {
      return;
    }
    const at = options.now();
    const accessToken = mintCredential(CREDENTIAL_PREFIX.accessToken, options.random);
    const tokenHash = hashCredential(accessToken);
    const expiresAt = at + options.accessTokenTtlMs;
    repos.tokens.insert({
      id: options.newId(),
      tokenHash,
      kind: 'access',
      familyId: options.newId(),
      parentId: undefined,
      replacedById: undefined,
      clientId,
      consentId: consent.id,
      scopes: SCOPES,
      resource,
      issuedAt: at,
      expiresAt,
      revokedAt: undefined,
      lastUsedAt: undefined,
    });
    const tokenId = tokenHash.slice(0, TOKEN_ID_LENGTH);
    options.audit.record({
      category: 'oauth',
      action: 'token_issued',
      outcome: 'ok',
      operatorId: consent.operatorId,
      clientId,
      tokenPrefix: tokenId,
      ip: request.ip,
      details: { via: 'relay', node: request.node },
    });
    return {
      clientId,
      tokenId,
      token: {
        object: 'token',
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: toSeconds(expiresAt - at),
        scope: SCOPES.join(' '),
        resource,
      },
    };
  };
}
