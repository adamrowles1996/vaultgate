import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';

import { StoreAuditSink } from './audit/store-sink.ts';
import {
  createVaultConnection,
  createVaultSettings,
  startVaultSupervisor,
} from './bitwarden/index.ts';
import { describeConfig, loadConfig } from './config/index.ts';
import { createApp } from './http/app.ts';
import { createGuards, createIdentity, CURRENT_PARAMETERS } from './identity/index.ts';
import { createLogger } from './logger.ts';
import { createPinnedHttpsFetch } from './net/pinned-https.ts';
import { createAuthorizationServer } from './oauth/server.ts';
import { openStore } from './storage/index.ts';

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(`vaultgate: ${loaded.error.message}\n`);
  process.exit(1);
}

const { config, warnings } = loaded.value;
const logger = createLogger(config.logLevel);
for (const warning of warnings) {
  logger.warn({ warning }, 'configuration warning');
}
logger.info({ config: describeConfig(config) }, 'configuration loaded');

// The store opens and migrates before anything can serve.
const opened = openStore(config, logger);
if (!opened.ok) {
  logger.fatal({ err: opened.error }, 'store failed to open');
  process.exit(1);
}
const store = opened.value;

// Every identity, OAuth and MCP event appends to the store (MCP-13…15).
const auditSink = new StoreAuditSink({
  database: store.db,
  logger,
  now: Date.now,
  newId: randomUUID,
});

// bw serve starts in the background with the stored connection or the
// environment seed (VAULT-18); the listener comes up regardless and /readyz
// names the vault until it is unlocked (VAULT-5).
const vaultSettings = createVaultSettings({
  database: store.db,
  secretKey: config.secrets.secretKey,
  random: (bytes) => randomBytes(bytes),
});
const vault = startVaultSupervisor(config, logger, {
  environment: process.env,
  stored: vaultSettings.load(),
});
const vaultConnection = createVaultConnection({
  supervisor: vault,
  settings: vaultSettings,
  clock: Date.now,
});

// The ID-18 guards are shared by the operator pages and the authorization
// server, so they are built first; the server follows, and identity last with
// the server's connected-clients renderer for the account page.
const guards = createGuards({
  publicUrl: config.publicUrl,
  trustProxy: config.trustProxy,
  trustedProxyHops: config.trustedProxyHops,
  clientAddress: (context) => getConnInfo(context).remote.address,
  audit: auditSink,
});
const oauth = createAuthorizationServer({
  config,
  db: store.db,
  guards,
  audit: auditSink,
  logger,
  fetch: createPinnedHttpsFetch(), // OAUTH-8: pinned to the address the SSRF check approved
  lookup: async (hostname) => {
    const entries = await lookup(hostname, { all: true });
    return entries.map((entry) => entry.address);
  },
  now: Date.now,
  random: randomBytes,
  newId: randomUUID,
});
if (!oauth.ok) {
  logger.fatal({ err: oauth.error }, 'invalid pre-registered OAuth clients');
  store.close();
  process.exit(1);
}
const identity = createIdentity({
  config,
  database: store.db,
  logger,
  audit: auditSink,
  random: (bytes) => randomBytes(bytes),
  clock: () => Date.now(),
  delay: (ms) => sleep(ms),
  guards,
  passwordParameters: CURRENT_PARAMETERS,
  connectedClients: oauth.value.renderConnectedClients,
  vaultConnection,
});
identity.bootstrap.ensureToken();

const app = createApp({
  config,
  logger,
  identity,
  readiness: () => {
    const failing = [
      ...(store.db.isOpen ? [] : ['store']), // -- storage --
      ...(vault.isReady() ? [] : ['vault']), // -- vault --
    ];
    return {
      ready: failing.length === 0,
      failing,
      // -- vault --
      vault: {
        ready: vault.isReady(),
        configured: vault.source().origin !== 'none',
        lastSyncAt: vault.syncState().lastSyncAt,
      },
      // -- end vault --
    };
  },
  vaultClient: vault.client,
  auditSink,
  tokenVerifier: oauth.value.tokenVerifier,
  oauth: oauth.value.routes,
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (address) => {
  logger.info({ host: address.address, port: address.port }, 'vaultgate listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  server.close((error) => {
    // Lock and stop bw serve before the store closes (VAULT-7).
    void vault.stop().then(() => {
      store.close();
      if (error) {
        logger.error({ err: error }, 'server did not close cleanly');
        process.exit(1);
      }
      process.exit(0);
    });
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
