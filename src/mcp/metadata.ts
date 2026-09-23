/**
 * Protected resource metadata (RFC 9728) for the MCP resource server
 * (spec §03.2: OAUTH-1, OAUTH-3, OAUTH-4; §03.9: OAUTH-37). Served at both
 * the path-aware and the root well-known location because clients differ.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { enabledScopes, type ScopeSwitches } from '../scopes/registry.ts';

import type { Config } from '../config/index.ts';

const RESOURCE_DOCUMENTATION_URL = 'https://github.com/adamrowles1996/vaultgate#readme';

/**
 * Header values shared by every CORS-enabled route (OAUTH-37): every request
 * header the SDK's Streamable HTTP entry reads, including the per-request
 * `Mcp-Method` and `Mcp-Name` of the 2026-07-28 wire format.
 */
export const CORS_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'Mcp-Session-Id',
  'Mcp-Protocol-Version',
  'Mcp-Method',
  'Mcp-Name',
] as const;
export const CORS_EXPOSE_HEADERS = ['WWW-Authenticate', 'Mcp-Session-Id'] as const;

const METADATA_CACHE_CONTROL = 'public, max-age=300';

export interface ResourceUrls {
  readonly issuer: string;
  readonly resource: string;
  readonly metadata: string;
}

/**
The canonical resource is `${publicUrl}/mcp` (spec §03.1); the issuer is the public URL itself.
*/
export function resourceUrls(config: Pick<Config, 'publicUrl'>): ResourceUrls {
  return {
    issuer: config.publicUrl,
    resource: `${config.publicUrl}/mcp`,
    metadata: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
  };
}

type MetadataConfig = Pick<Config, 'publicUrl'> & ScopeSwitches;

interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly ['header'];
  readonly resource_name: string;
  readonly resource_documentation: string;
}

function protectedResourceMetadata(config: MetadataConfig): ProtectedResourceMetadata {
  const urls = resourceUrls(config);
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    // OAUTH-1, OAUTH-16, ACT-14: the scopes this deployment grants; never offline_access (OAUTH-4).
    scopes_supported: enabledScopes(config),
    bearer_methods_supported: ['header'],
    resource_name: 'vaultgate',
    resource_documentation: RESOURCE_DOCUMENTATION_URL,
  };
}

/**
A sub-application serving the metadata document at both well-known paths.
*/
export function createMetadataApp(config: MetadataConfig): Hono {
  const app = new Hono();
  const document = protectedResourceMetadata(config);
  app.use(
    '/.well-known/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      exposeHeaders: [...CORS_EXPOSE_HEADERS],
    }),
  );
  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
  ]) {
    app.get(path, (context) => {
      context.header('Cache-Control', METADATA_CACHE_CONTROL);
      return context.json(document);
    });
  }
  return app;
}
