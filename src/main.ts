import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';

import { loadConnectors } from './actions/connectors/registry.ts';
import { createActionsEngine } from './actions/engine.ts';
import { createActionsPages } from './actions/pages/index.ts';
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
import { VERSION } from './version.ts';

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

// Every address a name maps to, for the SSRF checks of OAUTH-8 and ACT-55.
async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const entries = await lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
}

// The actions engine exists only when the layer is enabled (ACT-73). It is
// built before the authorization server and identity because both reach it
// through callbacks the composition wires here: consent revocation drops the
// client's grants (ACT-10), the account page gains its Actions section (ACT-5)
// and the MCP surface registers the actions tools.
const engine = config.actions.enabled
  ? createActionsEngine({
      config: config.actions,
      database: store.db,
      vault: vault.client,
      connectors: await loadConnectors(config.actions),
      lookup: resolveAddresses,
      audit: auditSink,
      logger,
      secretKey: config.secrets.secretKey,
      now: Date.now,
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => {
          clearTimeout(timer);
        };
      },
      random: randomBytes,
      newId: randomUUID,
    })
  : undefined;
if (engine !== undefined) {
  logger.info({ connectors: engine.connectors }, 'actions engine ready');
}

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
// The Actions pages come before the authorization server because the
// connected-clients list draws each client's grants through their renderer
// (ACT-9); they reach back for the consent holders through a closure, so
// neither layer imports the other (ACT-70).
const actionsPages =
  engine === undefined
    ? undefined
    : createActionsPages({
        targets: engine.targets,
        database: store.db,
        vault: vault.client,
        sensitiveAction: (context) => identity.sensitiveAction(context),
        operatorAction: (context) => identity.operatorAction(context),
        pageHeaders: (context, next) => identity.pageHeaders(context, next),
        // ACT-119, ACT-120: the repository list and check reach GitHub pinned, as calls do.
        github: {
          fetch: createPinnedHttpsFetch(),
          lookup: resolveAddresses,
          userAgent: `vaultgate/${VERSION}`,
        },
        code: engine.code,
        listClients: (operatorId) =>
          authorization.listConnectedClients(operatorId).map((client) => ({
            clientId: client.clientId,
            clientName: client.clientName,
          })),
        switches: { allowAnyCommand: config.actions.allowAnyCommand },
        renderConsole: (session, page) => identity.renderConsole(session, page),
        consoleAccess: (context) => identity.consoleAccess(context),
        now: Date.now,
      });
const oauth = createAuthorizationServer({
  config,
  db: store.db,
  guards,
  audit: auditSink,
  logger,
  fetch: createPinnedHttpsFetch(), // OAUTH-8: pinned to the address the SSRF check approved
  lookup: resolveAddresses,
  now: Date.now,
  random: randomBytes,
  newId: randomUUID,
  onConsentRevoked: (clientId) => {
    engine?.targets.onConsentRevoked(clientId);
  },
  clientTargets: actionsPages?.clientTargets,
});
if (!oauth.ok) {
  logger.fatal({ err: oauth.error }, 'invalid pre-registered OAuth clients');
  store.close();
  process.exit(1);
}
const authorization = oauth.value;
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
  connectedClients: authorization.renderConnectedClients,
  // The console's Computers pages, and what they add to Agents and Activity
  // (ACT-5), exist only with the actions layer; without it the console
  // starts at the connected agents.
  sections:
    actionsPages === undefined
      ? {}
      : { agents: [actionsPages.agentsSection], activity: [actionsPages.activitySection] },
  navigation: actionsPages?.navigation,
  homePath: actionsPages === undefined ? undefined : '/account/actions',
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
  tokenVerifier: authorization.tokenVerifier,
  oauth: authorization.routes,
  engine,
  actionsPages: actionsPages?.routes,
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
