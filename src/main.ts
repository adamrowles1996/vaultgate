import { serve } from '@hono/node-server';

import { describeConfig, loadConfig } from './config/index.ts';
import { createApp } from './http/app.ts';
import { createLogger } from './logger.ts';
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

const app = createApp({
  logger,
  // -- storage: bw serve joins this report in the vault-backend milestone --
  readiness: () =>
    store.db.isOpen ? { ready: true, failing: [] } : { ready: false, failing: ['store'] },
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (address) => {
  logger.info({ host: address.address, port: address.port }, 'vaultgate listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  server.close((error) => {
    store.close(); // -- storage --
    if (error) {
      logger.error({ err: error }, 'server did not close cleanly');
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
