import { Hono } from 'hono';
import { requestId } from 'hono/request-id';

import { base32Decode } from '../identity/base32.ts';
import { type ConnectedClientsRenderer, createIdentity, type Identity } from '../identity/index.ts';
import { createIdentityStores, type IdentityStores } from '../identity/repositories/index.ts';
import { totp } from '../identity/totp.ts';

import { type Browser, createBrowser } from './browser.ts';
import { openTestDatabase } from './database.ts';
import { sequentialRandom } from './identity.ts';
import { captureLogger } from './logging.ts';

import type { AuditEvent } from '../audit/event.ts';
import type { IdentityEnvironment } from '../identity/browser.ts';
import type { DatabaseSync } from 'node:sqlite';

const START = Date.parse('2026-09-22T12:00:00Z');
const PUBLIC_URL = 'https://vault.example.com';
const FAST_SCRYPT = { cost: 2 ** 4, blockSize: 8, parallelism: 1 };
const SECRET_KEY = Buffer.alloc(32, 9);

export interface HarnessOptions {
  readonly publicUrl?: string;
  readonly trustProxy?: boolean;
  readonly bootstrapToken?: string;
  /**
  The account page's connected-clients section, supplied by the OAuth harness.
  */
  readonly connectedClients?: ConnectedClientsRenderer;
}

export interface Harness {
  readonly app: Hono<IdentityEnvironment>;
  readonly identity: Identity;
  readonly database: DatabaseSync;
  readonly stores: IdentityStores;
  readonly audits: AuditEvent[];
  readonly delays: number[];
  readonly logged: () => readonly Record<string, unknown>[];
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  readonly browser: () => Browser;
  /**
  The `/setup?token=…` URL from the start-up log.
  */
  readonly setupToken: () => string;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const publicUrl = options.publicUrl ?? PUBLIC_URL;
  const database = openTestDatabase();
  const { logger, lines } = captureLogger();
  const audits: AuditEvent[] = [];
  const delays: number[] = [];
  let now = START;
  const identity = createIdentity({
    config: {
      publicUrl,
      trustProxy: options.trustProxy ?? false,
      sessionTtlMs: 12 * 3_600_000,
      secrets: {
        secretKey: SECRET_KEY,
        masterPassword: 'unused',
        clientSecret: 'unused',
        bootstrapToken: options.bootstrapToken,
      },
    },
    database,
    logger,
    audit: {
      record: (event) => {
        audits.push(event);
      },
    },
    random: sequentialRandom(),
    clock: () => now,
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    clientAddress: () => '203.0.113.7',
    passwordParameters: FAST_SCRYPT,
    connectedClients: options.connectedClients,
  });
  const app = new Hono<IdentityEnvironment>();
  app.use(requestId());
  app.use(identity.attachSession);
  app.route('/', identity.routes);
  return {
    app,
    identity,
    database,
    stores: createIdentityStores(database),
    audits,
    delays,
    logged: lines,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    browser: () => createBrowser(app, publicUrl),
    setupToken: () => {
      const line = lines().find((entry) => String(entry['msg']).includes('/setup?token='));
      return String(line?.['msg']).split('token=', 2)[1]?.split(' ', 1)[0] ?? '';
    },
  };
}

export function csrfOf(markup: string): string {
  return /name="csrf" value="([^"]+)"/.exec(markup)?.[1] ?? '';
}

export function enrolmentKeyOf(markup: string): string {
  return /manually:\s*<code>([A-Z2-7]+)<\/code>/.exec(markup)?.[1] ?? '';
}

export function recoveryCodesOf(markup: string): string[] {
  return Array.from(
    markup.matchAll(/<li><code>([A-Z2-7]{10})<\/code><\/li>/g),
    (match) => match[1] ?? '',
  );
}

export async function pageText(browser: Browser, path: string): Promise<string> {
  const response = await browser.get(path);
  return response.text();
}

export async function statusOf(browser: Browser, path: string): Promise<number> {
  const response = await browser.get(path);
  return response.status;
}

export function totpFor(key: string, nowMs: number): string {
  return totp(base32Decode(key) ?? Buffer.alloc(0), nowMs);
}

export const PASSWORD = 'a perfectly serviceable passphrase';
export const EMAIL = 'ada@example.com';

export interface OperatorSetup {
  readonly browser: Browser;
  readonly key: string;
  readonly recoveryCodes: string[];
}

/**
Runs the whole first-run flow; the returned browser is signed in.
*/
export async function setUpOperator(harness: Harness): Promise<OperatorSetup> {
  harness.identity.bootstrap.ensureToken();
  const browser = harness.browser();
  const form = await browser.get(`/setup?token=${harness.setupToken()}`);
  const markup = await form.text();
  const key = enrolmentKeyOf(markup);
  const done = await browser.submit('/setup', {
    token: harness.setupToken(),
    csrf: csrfOf(markup),
    email: EMAIL,
    password: PASSWORD,
    code: totpFor(key, harness.now()),
  });
  return { browser, key, recoveryCodes: recoveryCodesOf(await done.text()) };
}

/**
Strips the operator's e-mail address, as a row from before the `operator-email` migration (ID-26).
*/
export function makeLegacy(harness: Harness): void {
  harness.database.exec('UPDATE operators SET email = NULL');
}

/**
Signs a fresh browser in: e-mail address (unless legacy) and password, then a second-factor code.
*/
export async function signIn(harness: Harness, code: string, next?: string): Promise<Browser> {
  const browser = harness.browser();
  const page = await browser.get(next === undefined ? '/login' : `/login?next=${next}`);
  const csrf = csrfOf(await page.text());
  const nextField = next === undefined ? {} : { next };
  const isLegacy = harness.stores.operators.findAny()?.email === undefined;
  const emailField = isLegacy ? {} : { email: EMAIL };
  await browser.submit('/login', { csrf, ...emailField, password: PASSWORD, ...nextField });
  await browser.submit('/login/verify', { csrf, code, ...nextField });
  return browser;
}
