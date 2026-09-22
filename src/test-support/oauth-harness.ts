import { type Config, loadConfig } from '../config/index.ts';
import { type App, createApp } from '../http/app.ts';
import { EMPTY } from '../identity/pages/template.ts';
import { createSessionManager } from '../identity/session-manager.ts';
import { createOAuthRepos, type OAuthRepos } from '../oauth/repositories/index.ts';
import { type AuthorizationServer, createAuthorizationServer } from '../oauth/server.ts';
import { run } from '../storage/query.ts';

import { type Browser as CookieBrowser, createBrowser } from './browser.ts';
import {
  createHarness as createIdentityHarness,
  type Harness as IdentityHarness,
} from './identity-app.ts';
import { sequentialRandom } from './identity.ts';
import { InMemoryVaultClient } from './in-memory-vault-client.ts';
import { captureLogger } from './logging.ts';
import { unwrapOk } from './result.ts';

import type { AuditEvent } from '../audit/event.ts';
import type { PreregisteredClient } from '../config/primitives.ts';
import type { ConnectedClientsRenderer } from '../identity/index.ts';
import type { SessionState } from '../identity/session-manager.ts';

export const PUBLIC_URL = 'https://vault.example.com';
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const OPERATOR_ID = 'operator-1';
const CLIENT_IP = '203.0.113.7';
const PUBLIC_ADDRESS = '93.184.216.34';
const SESSION_TTL_MS = 12 * 3_600_000;

export interface HarnessOptions {
  readonly publicUrl?: string;
  readonly enableWriteScope?: boolean;
  readonly oauthClients?: readonly PreregisteredClient[];
  readonly trustProxy?: boolean;
  /**
  DNS answers for CIMD hosts; every host resolves to one public address by default.
  */
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
}

export interface SignedIn {
  readonly session: SessionState;
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
  readonly identity: IdentityHarness;
  readonly server: AuthorizationServer;
  readonly repos: OAuthRepos;
  readonly audit: readonly AuditEvent[];
  readonly mcpAudit: readonly AuditEvent[];
  readonly logLines: () => readonly Record<string, unknown>[];
  /**
  CIMD documents served by the injected fetch, keyed by URL.
  */
  readonly cimd: Map<string, () => Response>;
  readonly fetchedUrls: readonly string[];
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  /**
  A real session minted through the identity session manager, without the login pages.
  */
  readonly signIn: (
    operatorId?: string,
    /**
    `reauthenticated` marks the session as inside the ID-15 re-authentication window.
    */
    options?: { readonly reauthenticated?: boolean },
  ) => SignedIn;
  /**
  Creates the operator row when absent, for tests that seed consents without signing in.
  */
  readonly ensureOperator: (operatorId?: string) => void;
  /**
  A cookie-jar browser over the full app; signed in when given a session.
  */
  readonly browser: (signedIn?: SignedIn) => CookieBrowser;
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

function ensureOperator(identity: IdentityHarness, operatorId: string): void {
  if (identity.stores.operators.findById(operatorId) === undefined) {
    run(
      identity.database,
      `INSERT INTO operators (id, display_name, password_hash, created_at, password_changed_at)
        VALUES (?, ?, ?, ?, ?)`,
      operatorId,
      'Operator',
      'hash',
      0,
      0,
    );
  }
}

/**
 * The full application — probes, identity pages, MCP resource server and
 * the authorization server — over one in-memory store, with the real
 * identity module and every external dependency faked: the clock and random
 * source are deterministic and fetch/lookup never touch the network (QG-2).
 */
export function createOAuthHarness(options: HarnessOptions = {}): OAuthHarness {
  const config = harnessConfig(options);
  const accountSlot: { render: ConnectedClientsRenderer } = { render: () => EMPTY };
  const identity = createIdentityHarness({
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    connectedClients: (session) => accountSlot.render(session),
  });
  let counter = 0;
  const audit: AuditEvent[] = [];
  const mcpAudit: AuditEvent[] = [];
  const cimd = new Map<string, () => Response>();
  const fetchedUrls: string[] = [];
  const { logger, lines } = captureLogger();
  const sessions = createSessionManager({
    sessions: identity.stores.sessions,
    random: sequentialRandom(),
    clock: identity.now,
    absoluteTtlMs: SESSION_TTL_MS,
  });

  const server = unwrapOk(
    createAuthorizationServer({
      config,
      db: identity.database,
      guards: identity.identity.guards,
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
      now: identity.now,
      random: (bytes) => {
        counter += 1;
        const buffer = Buffer.alloc(bytes);
        buffer.writeUInt32BE(counter, bytes - 4);
        return buffer;
      },
      newId: () => `id-${(counter += 1)}`,
    }),
  );
  accountSlot.render = server.renderConnectedClients;
  const app = createApp({
    config,
    logger,
    readiness: () => ({ ready: true, failing: [] }),
    identity: identity.identity,
    vaultClient: new InMemoryVaultClient(),
    tokenVerifier: server.tokenVerifier,
    auditSink: {
      record: (event) => {
        mcpAudit.push(event);
      },
    },
    now: identity.now,
    oauth: server.routes,
  });
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(`${config.publicUrl}${path}`, init));
  const cookieName = identity.identity.cookiePolicy.sessionCookieName;

  return {
    app,
    config,
    identity,
    server,
    repos: createOAuthRepos(identity.database),
    audit,
    mcpAudit,
    logLines: lines,
    cimd,
    fetchedUrls,
    now: identity.now,
    advance: identity.advance,
    ensureOperator: (operatorId = OPERATOR_ID) => {
      ensureOperator(identity, operatorId);
    },
    signIn: (operatorId = OPERATOR_ID, signInOptions = {}) => {
      ensureOperator(identity, operatorId);
      const started = sessions.start(operatorId, { ip: CLIENT_IP, userAgent: 'test' });
      if (signInOptions.reauthenticated === true) {
        sessions.markReauthenticated(started.state.idHash);
      }
      return {
        session: sessions.resolve(started.id) ?? started.state,
        headers: {
          cookie: `${cookieName}=${started.id}`,
          origin: new URL(config.publicUrl).origin,
        },
      };
    },
    browser: (signedIn) => {
      const browser = createBrowser(app, config.publicUrl);
      const cookie = signedIn?.headers['cookie'];
      if (cookie !== undefined) {
        const [name = '', value = ''] = cookie.split('=', 2);
        browser.cookies.set(name, value);
      }
      return browser;
    },
    request,
    exchange: async (path, init) => {
      const response = await request(path, init);
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
  };
}
