import { serve } from '@hono/node-server';

import { describeConfig, loadConfig } from './config/index.ts';
import { createApp } from './http/app.ts';
import { createLogger } from './logger.ts';

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

const app = createApp({ logger });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (address) => {
  logger.info({ host: address.address, port: address.port }, 'vaultgate listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'server did not close cleanly');
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
