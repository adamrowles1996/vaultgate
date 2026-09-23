import { Writable } from 'node:stream';

import { loadConfig } from '../config/index.ts';
import { type App, createApp, type Readiness } from '../http/app.ts';
import { createLogger } from '../logger.ts';

import { createHarness } from './identity-app.ts';
import { InMemoryTokenVerifier } from './in-memory-token-verifier.ts';
import { InMemoryVaultClient } from './in-memory-vault-client.ts';
import { unwrapOk } from './result.ts';

import type { ActionsEngine } from '../actions/engine.ts';
import type { AuditEvent, AuditSink } from '../audit/event.ts';
import type { Config } from '../config/index.ts';
import type { Identity } from '../identity/index.ts';

export const TEST_PUBLIC_URL = 'https://vault.example.com';
export const TEST_RESOURCE = `${TEST_PUBLIC_URL}/mcp`;
export const TEST_METADATA_URL = `${TEST_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
const TEST_EPOCH_MS = Date.parse('2026-09-22T12:00:00.000Z');
export const READY: Readiness = {
  ready: true,
  failing: [],
  vault: { ready: true, configured: true, lastSyncAt: '2026-09-22T12:00:00.000Z' },
};

class RecordingAuditSink implements AuditSink {
  readonly events: AuditEvent[];

  constructor(events: AuditEvent[] = []) {
    this.events = events;
  }

  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

/**
A settable clock so rate limits and expiries are tested without waiting.
*/
export class FakeClock {
  #nowMs: number;

  constructor(startMs: number = TEST_EPOCH_MS) {
    this.#nowMs = startMs;
  }

  now(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

export interface TestConfigOverrides {
  readonly VAULTGATE_ENABLE_WRITE_SCOPE?: string;
  readonly VAULTGATE_ALLOWED_ORIGINS?: string;
  readonly VAULTGATE_TRUST_PROXY?: string;
  readonly VAULTGATE_TRUSTED_PROXY_HOPS?: string;
  readonly VAULTGATE_PUBLIC_URL?: string;
  readonly VAULTGATE_ENABLE_ACTIONS?: string;
  readonly VAULTGATE_ACTIONS_ENABLE_HTTP?: string;
  readonly VAULTGATE_ACTIONS_ENABLE_SQL?: string;
  readonly VAULTGATE_ACTIONS_ENABLE_BROWSER?: string;
  readonly VAULTGATE_ACTIONS_BROWSER_CDP_URL?: string;
}

export function testConfig(overrides: TestConfigOverrides = {}): Config {
  const loaded = loadConfig({
    VAULTGATE_PUBLIC_URL: TEST_PUBLIC_URL,
    VAULTGATE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    VAULTGATE_BW_PASSWORD: 'test-master-password',
    VAULTGATE_BW_CLIENT_ID: 'user.test',
    VAULTGATE_BW_CLIENT_SECRET: 'test-client-secret',
    VAULTGATE_ENABLE_WRITE_SCOPE: 'true',
    ...overrides,
  });
  return unwrapOk(loaded).config;
}

export interface TestApp {
  readonly app: App;
  readonly config: Config;
  readonly vault: InMemoryVaultClient;
  readonly verifier: InMemoryTokenVerifier;
  readonly audit: RecordingAuditSink;
  readonly clock: FakeClock;
  /**
  Everything the logger wrote, for redaction and canary assertions.
  */
  readonly logged: () => string;
}

export interface TestAppOptions {
  readonly config?: Config;
  readonly vault?: InMemoryVaultClient;
  readonly readiness?: () => Readiness;
  readonly withClock?: boolean;
  /**
  The identity module; defaults to one over a fresh in-memory store.
  */
  readonly identity?: Identity;
  /**
  The actions engine behind the actions tools (ACT-73); absent by default.
  */
  readonly engine?: ActionsEngine;
  /**
  A trail to share with the engine, so one array holds every event of a call.
  */
  readonly audit?: AuditEvent[];
}

export function createTestApp(options: TestAppOptions = {}): TestApp {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const config = options.config ?? testConfig();
  const clock = new FakeClock();
  const vault = options.vault ?? new InMemoryVaultClient();
  const verifier = new InMemoryTokenVerifier({
    resource: `${config.publicUrl}/mcp`,
    now: () => clock.now(),
  });
  const audit = new RecordingAuditSink(options.audit);
  const app = createApp({
    config,
    logger: createLogger('info', sink),
    readiness: options.readiness ?? (() => READY),
    identity: options.identity ?? createHarness({ publicUrl: config.publicUrl }).identity,
    vaultClient: vault,
    tokenVerifier: verifier,
    auditSink: audit,
    ...(options.withClock !== false && { now: () => clock.now() }),
    ...(options.engine !== undefined && { engine: options.engine }),
  });
  return { app, config, vault, verifier, audit, clock, logged: () => chunks.join('') };
}
