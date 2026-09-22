import { createApp, type App } from '../http/app.ts';
import { type AuditEvent } from '../oauth/audit.ts';
import { createAuthorizationServer, type AuthorizationServer } from '../oauth/server.ts';
import { createOAuthRepos, type OAuthRepos } from '../oauth/repositories/index.ts';
import { IN_MEMORY, openDatabase } from '../storage/database.ts';
import { migrate } from '../storage/migrate.ts';
import { MIGRATIONS } from '../storage/migrations/index.ts';
import { run } from '../storage/query.ts';

import { captureLogger } from './logging.ts';
import { unwrapOk } from './result.ts';

import type { PreregisteredClient } from '../config/primitives.ts';
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
  readonly startAt?: number;
}

export interface Browser {
  readonly session: OperatorSession;
  /**
  Headers a signed-in, same-origin browser sends.
  */
  readonly headers: Readonly<Record<string, string>>;
}

export interface OAuthHarness {
  readonly app: App;
  readonly server: AuthorizationServer;
  readonly repos: OAuthRepos;
  readonly audit: readonly AuditEvent[];
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
}

/**
 * The full authorization server over an in-memory store with every external
 * dependency faked: sessions come from a `sid` cookie, the clock and random
 * source are deterministic, and fetch/lookup never touch the network (QG-2).
 */
export function createOAuthHarness(options: HarnessOptions = {}): OAuthHarness {
  const publicUrl = options.publicUrl ?? PUBLIC_URL;
  let at = options.startAt ?? 1_700_000_000_000;
  let counter = 0;
  const sessions = new Map<string, OperatorSession>();
  const audit: AuditEvent[] = [];
  const cimd = new Map<string, () => Response>();
  const fetchedUrls: string[] = [];
  const { logger, lines } = captureLogger();

  const db = openDatabase({ path: IN_MEMORY, networkFs: false });
  unwrapOk(migrate(db, MIGRATIONS, new Date(0)));
  run(
    db,
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
      config: {
        publicUrl,
        enableWriteScope: options.enableWriteScope ?? false,
        oauthClients: options.oauthClients ?? [],
        accessTokenTtlMs: 3_600_000,
        refreshTokenTtlMs: 30 * 86_400_000,
        trustProxy: options.trustProxy ?? false,
      },
      db,
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
        return Promise.resolve(document === undefined ? new Response('', { status: 404 }) : document());
      },
      lookup: () => Promise.resolve([PUBLIC_ADDRESS]),
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
  const app = createApp({ logger, readiness: () => ({ ready: true, failing: [] }), oauth: server.routes });

  return {
    app,
    server,
    repos: createOAuthRepos(db),
    audit,
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
      return { session, headers: { cookie: `sid=${session.sessionKey}`, origin: new URL(publicUrl).origin } };
    },
    request: (path, init) => app.request(`${publicUrl}${path}`, init),
  };
}

export function formBody(fields: Readonly<Record<string, string>>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

export function jsonBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
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
    new Response(JSON.stringify({ client_id: clientId, client_name: 'CIMD Agent', redirect_uris: redirectUris }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
    });
}
