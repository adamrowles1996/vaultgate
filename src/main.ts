import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';

import { startVaultSupervisor } from './bitwarden/index.ts';
import { describeConfig, loadConfig } from './config/index.ts';
import { createApp } from './http/app.ts';
import { createIdentity, CURRENT_PARAMETERS } from './identity/index.ts';
import { createLogger } from './logger.ts';
import { LoggingAuditSink } from './mcp/audit.ts';
import { RejectAllTokenVerifier } from './mcp/token-verifier.ts';
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

// -- vault: bw serve starts in the background; the listener comes up regardless
// and /readyz names the vault until it is unlocked (VAULT-5) -----------------
const vault = startVaultSupervisor(config, logger, { environment: process.env });
// -- end vault ---------------------------------------------------------------

// -- identity: spec 04, wired with real entropy, clock, sleep and socket addresses --
const identity = createIdentity({
  config,
  database: store.db,
  logger,
  audit: (event) => {
    logger.info({ audit: event }, 'audit event');
  },
  random: (bytes) => randomBytes(bytes),
  clock: () => Date.now(),
  delay: (ms) => sleep(ms),
  clientAddress: (context) => getConnInfo(context).remote.address,
  passwordParameters: CURRENT_PARAMETERS,
});
identity.bootstrap.ensureToken();
// -- end identity --

const app = createApp({
  config,
  logger,
  identity,
  readiness: () => {
    const failing = [
      ...(store.db.isOpen ? [] : ['store']), // -- storage --
      ...(vault.isReady() ? [] : ['vault']), // -- vault --
    ];
    return { ready: failing.length === 0, failing };
  },
  // -- MCP: the OAuth token store replaces the verifier in a later milestone --
  vaultClient: vault.client, // -- vault --
  tokenVerifier: new RejectAllTokenVerifier(),
  auditSink: new LoggingAuditSink(logger),
  // -- end MCP ---------------------------------------------------------------
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
