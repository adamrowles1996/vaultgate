import { loadConfig, type Config } from '../config/index.ts';
import { type App, createApp } from '../http/app.ts';
import { createOAuthRepos, type OAuthRepos } from '../oauth/repositories/index.ts';
import { createAuthorizationServer, type AuthorizationServer } from '../oauth/server.ts';
import { IN_MEMORY, openDatabase } from '../storage/database.ts';
import { migrate } from '../storage/migrate.ts';
import { MIGRATIONS } from '../storage/migrations/index.ts';
import { run } from '../storage/query.ts';

import { InMemoryVaultClient } from './in-memory-vault-client.ts';
import { captureLogger } from './logging.ts';
import { unwrapOk } from './result.ts';

import type { PreregisteredClient } from '../config/primitives.ts';
import type { AuditEvent as McpAuditEvent } from '../mcp/audit.ts';
import type { AuditEvent } from '../oauth/audit.ts';
import type { OperatorSession } from '../oauth/session.ts';

export const PUBLIC_URL = 'https://vault.example.com';
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const OPERATOR_ID = 'operator-1';
export const CLIENT_IP = '203.0.113.7';
export const PUBLIC_ADDRESS = '93.184.216.34';

export interface HarnessOptions {
  readonly publicUrl?: string;
  readonly enableWriteScope?: boolean;
  readonly oauthClients?: readonly PreregisteredClient[];
  readonly trustProxy?: boolean;
  readonly loginPath?: string;
  /**
  DNS answers for CIMD hosts; every host resolves to one public address by default.
  */
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
}

export interface Browser {
  readonly session: OperatorSession;
  /**
  Headers a signed-in, same-origin browser sends.
  */
  readonly headers: Readonly<Record<string, string>>;
}

export interface Exchange {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

export interface OAuthHarness {
  readonly app: App;
  readonly config: Config;
  readonly server: AuthorizationServer;
  readonly repos: OAuthRepos;
  readonly audit: readonly AuditEvent[];
  readonly mcpAudit: readonly McpAuditEvent[];
  readonly logLines: () => readonly Record<string, unknown>[];
  /**
  CIMD documents served by the injected fetch, keyed by URL.
  */
  readonly cimd: Map<string, () => Response>;
  readonly fetchedUrls: readonly string[];
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  readonly signIn: (operatorId?: string) => Browser;
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  /**
  A request whose body has been read, so tests never chain members off an await.
  */
  readonly exchange: (path: string, init?: RequestInit) => Promise<Exchange>;
}

function harnessConfig(options: HarnessOptions): Config {
  const clients = (options.oauthClients ?? []).map((client) => ({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
  }));
  const loaded = loadConfig({
    VAULTGATE_PUBLIC_URL: options.publicUrl ?? PUBLIC_URL,
    VAULTGATE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    VAULTGATE_BW_PASSWORD: 'test-master-password',
    VAULTGATE_BW_CLIENT_ID: 'user.test',
    VAULTGATE_BW_CLIENT_SECRET: 'test-client-secret',
    VAULTGATE_ENABLE_WRITE_SCOPE: options.enableWriteScope === true ? 'true' : 'false',
    VAULTGATE_TRUST_PROXY: options.trustProxy === true ? 'true' : 'false',
    VAULTGATE_OAUTH_CLIENTS: JSON.stringify(clients),
  });
  return unwrapOk(loaded).config;
}

/**
 * The full application — probes, MCP resource server and the authorization
 * server — over an in-memory store with every external dependency faked:
 * sessions come from a `sid` cookie, the clock and random source are
 * deterministic, and fetch/lookup never touch the network (QG-2).
 */
export function createOAuthHarness(options: HarnessOptions = {}): OAuthHarness {
  const config = harnessConfig(options);
  let at = 1_700_000_000_000;
  let counter = 0;
  const sessions = new Map<string, OperatorSession>();
  const audit: AuditEvent[] = [];
  const mcpAudit: McpAuditEvent[] = [];
  const cimd = new Map<string, () => Response>();
  const fetchedUrls: string[] = [];
  const { logger, lines } = captureLogger();

  const database = openDatabase({ path: IN_MEMORY, networkFs: false });
  unwrapOk(migrate(database, MIGRATIONS, new Date(0)));
  run(
    database,
    `INSERT INTO operators (id, display_name, password_hash, created_at, password_changed_at)
     VALUES (?, ?, ?, ?, ?)`,
    OPERATOR_ID,
    'Operator',
    'hash',
    0,
    0,
  );

  const server = unwrapOk(
    createAuthorizationServer({
      config,
      db: database,
      sessions: {
        resolve: (request) => {
          const cookie = request.headers.get('cookie') ?? '';
          const match = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
          return Promise.resolve(match?.[1] === undefined ? undefined : sessions.get(match[1]));
        },
      },
      audit: {
        record: (event) => {
          audit.push(event);
        },
      },
      logger,
      fetch: (url) => {
        fetchedUrls.push(url);
        const document = cimd.get(url);
        return Promise.resolve(
          document === undefined ? new Response('', { status: 404 }) : document(),
        );
      },
      lookup: options.lookup ?? (() => Promise.resolve([PUBLIC_ADDRESS])),
      now: () => at,
      random: (bytes) => {
        counter += 1;
        const buffer = Buffer.alloc(bytes);
        buffer.writeUInt32BE(counter, bytes - 4);
        return buffer;
      },
      newId: () => `id-${(counter += 1)}`,
      socketAddress: () => CLIENT_IP,
      loginPath: options.loginPath,
    }),
  );
  const app = createApp({
    config,
    logger,
    readiness: () => ({ ready: true, failing: [] }),
    vaultClient: new InMemoryVaultClient(),
    tokenVerifier: server.tokenVerifier,
    auditSink: {
      record: (event) => {
        mcpAudit.push(event);
      },
    },
    now: () => at,
    oauth: server.routes,
  });
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(`${config.publicUrl}${path}`, init));

  return {
    app,
    config,
    server,
    repos: createOAuthRepos(database),
    audit,
    mcpAudit,
    logLines: lines,
    cimd,
    fetchedUrls,
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
    signIn: (operatorId = OPERATOR_ID) => {
      counter += 1;
      const session: OperatorSession = {
        operatorId,
        sessionKey: `session-${counter}`,
        csrfToken: `csrf-${counter}`,
      };
      sessions.set(session.sessionKey, session);
      return {
        session,
        headers: { cookie: `sid=${session.sessionKey}`, origin: new URL(config.publicUrl).origin },
      };
    },
    request,
    exchange: async (path, init) => {
      const response = await request(path, init);
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
  };
}

export function formBody(
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

export function jsonBody(
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function parseJson(exchange: Exchange): Record<string, unknown> {
  return JSON.parse(exchange.text) as Record<string, unknown>;
}

export interface ConsentForm {
  readonly requestId: string;
  readonly csrfToken: string;
  readonly html: string;
}

export function parseConsentForm(html: string): ConsentForm {
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { requestId, csrfToken, html };
}

export function cimdDocument(clientId: string, redirectUris: readonly string[]): () => Response {
  return () =>
    Response.json(
      { client_id: clientId, client_name: 'CIMD Agent', redirect_uris: redirectUris },
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
      },
    );
}

/**
 * Drives the browser half of the authorization flow (spec §02.3.1 steps 4–6)
 * for a signed-in operator and yields the consent form ready to post.
 */
export async function openConsent(
  harness: OAuthHarness,
  browser: Browser,
  parameters: Readonly<Record<string, string>>,
): Promise<ConsentForm> {
  const search = new URLSearchParams(parameters).toString();
  const started = await harness.exchange(`/oauth/authorize?${search}`, {
    headers: browser.headers,
  });
  const path = started.headers.get('location') ?? '';
  const page = await harness.exchange(path, { headers: browser.headers });
  return parseConsentForm(page.text);
}
