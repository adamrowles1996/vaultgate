/**
 * `node dist/cli.js audit export --from <iso> --to <iso> [--format csv]`
 * (OPS-5): the same export as the account page, for scripted retention.
 * Reads the store read-only under the server's configuration and streams
 * the lines to standard output; nothing else in the process writes there.
 */
import { parseExportArguments, USAGE, writeAuditExport } from './audit/export-command.ts';
import { loadConfig } from './config/index.ts';
import { openReadOnlyDatabase } from './storage/database.ts';
import { databasePath } from './storage/index.ts';

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(`vaultgate: ${loaded.error.message}\n`);
  process.exit(1);
}

const request = parseExportArguments(process.argv.slice(2));
if (!request.ok) {
  process.stderr.write(`vaultgate: ${request.error.message}\n${USAGE}\n`);
  process.exit(2);
}

const database = openReadOnlyDatabase(databasePath(loaded.value.config));
try {
  await writeAuditExport(database, request.value, process.stdout);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vaultgate: audit export failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  database?.close();
}
