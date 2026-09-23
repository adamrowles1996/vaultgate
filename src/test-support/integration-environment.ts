/**
 * The only place the integration suite reads its environment. With none of
 * the `VAULTGATE_TEST_BW_*` credentials set the suite skips, so a bare
 * `vitest run` still passes; a partial set is a mis-configured job and fails
 * loudly rather than passing by doing nothing.
 */
export interface IntegrationEnvironment {
  readonly path: string | undefined;
  readonly home: string | undefined;
  readonly bin: string;
  readonly server: string | undefined;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly masterPassword: string;
}

const REQUIRED = [
  'VAULTGATE_TEST_BW_CLIENT_ID',
  'VAULTGATE_TEST_BW_CLIENT_SECRET',
  'VAULTGATE_TEST_BW_PASSWORD',
] as const;

/**
`undefined` when no credential is set; throws when only some are.
*/
export function readIntegrationEnvironment(): IntegrationEnvironment | undefined {
  const missing = REQUIRED.filter((name) => (process.env[name] ?? '') === '');
  if (missing.length === REQUIRED.length) {
    return undefined;
  }
  if (missing.length > 0) {
    throw new Error(`integration test needs ${missing.join(', ')}`);
  }
  return {
    path: process.env['PATH'],
    home: process.env['HOME'],
    bin: process.env['VAULTGATE_TEST_BW_BIN'] ?? 'bw',
    server: process.env['VAULTGATE_TEST_BW_SERVER'],
    clientId: process.env['VAULTGATE_TEST_BW_CLIENT_ID'] ?? '',
    clientSecret: process.env['VAULTGATE_TEST_BW_CLIENT_SECRET'] ?? '',
    masterPassword: process.env['VAULTGATE_TEST_BW_PASSWORD'] ?? '',
  };
}
