import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';

import { StoreAuditSink } from './audit/store-sink.ts'; // -- audit --
import {
  createVaultConnection,
  createVaultSettings,
  startVaultSupervisor,
} from './bitwarden/index.ts';
import { describeConfig, loadConfig } from './config/index.ts';
import { createApp } from './http/app.ts';
import {
  type ConnectedClientsRenderer,
  createIdentity,
  CURRENT_PARAMETERS,
} from './identity/index.ts';
import { EMPTY } from './identity/pages/template.ts';
import { createLogger } from './logger.ts';
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

// -- storage: open and migrate before anything can serve --------------------
const opened = openStore(config, logger);
if (!opened.ok) {
  logger.fatal({ err: opened.error }, 'store failed to open');
  process.exit(1);
}
const store = opened.value;
// -- end storage -------------------------------------------------------------

// -- audit: every identity, OAuth and MCP event appends to the store (MCP-13…15)
const auditSink = new StoreAuditSink({
  database: store.db,
  logger,
  now: Date.now,
  newId: randomUUID,
});
// -- end audit ---------------------------------------------------------------

// -- vault: bw serve starts in the background with the stored connection or the
// environment seed (VAULT-18); the listener comes up regardless and /readyz
// names the vault until it is unlocked (VAULT-5) -----------------------------
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
// -- end vault ---------------------------------------------------------------

// -- oauth: the account page's connected-clients section is bound once the
// authorization server exists; identity is composed first because the
// server needs its guards.
const accountSlot: { render: ConnectedClientsRenderer } = { render: () => EMPTY };
// -- end oauth --

// -- identity: spec 04, wired with real entropy, clock, sleep and socket addresses --
const identity = createIdentity({
  config,
  database: store.db,
  logger,
  audit: auditSink, // -- audit --
  random: (bytes) => randomBytes(bytes),
  clock: () => Date.now(),
  delay: (ms) => sleep(ms),
  clientAddress: (context) => getConnInfo(context).remote.address,
  passwordParameters: CURRENT_PARAMETERS,
  connectedClients: (session) => accountSlot.render(session), // -- oauth --
  vaultConnection, // -- vault --
});
identity.bootstrap.ensureToken();
// -- end identity --

// -- oauth: the authorization server over the open store (spec 03) ----------
const oauth = createAuthorizationServer({
  config,
  db: store.db,
  guards: identity.guards,
  audit: auditSink, // -- audit --
  logger,
  fetch: (url, init) => fetch(url, init),
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
accountSlot.render = oauth.value.renderConnectedClients;
// -- end oauth ---------------------------------------------------------------

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
  vaultClient: vault.client, // -- vault --
  auditSink, // -- audit --
  // -- oauth: bearer tokens are verified against the token store ------------
  tokenVerifier: oauth.value.tokenVerifier,
  oauth: oauth.value.routes,
  // -- end oauth -------------------------------------------------------------
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (address) => {
  logger.info({ host: address.address, port: address.port }, 'vaultgate listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  server.close((error) => {
    // -- vault: lock and stop bw serve before the store closes (VAULT-7) ----
    void vault.stop().then(() => {
      store.close(); // -- storage --
      if (error) {
        logger.error({ err: error }, 'server did not close cleanly');
        process.exit(1);
      }
      process.exit(0);
    });
    // -- end vault ---------------------------------------------------------
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
