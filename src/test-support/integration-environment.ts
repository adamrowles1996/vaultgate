/**
 * The only place the integration suite reads its environment. Every variable
 * is required: a missing one fails the run loudly rather than skipping it,
 * so a mis-configured job can never pass by doing nothing.
 */
export interface IntegrationEnvironment {
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

export function readIntegrationEnvironment(): IntegrationEnvironment {
  const missing = REQUIRED.filter((name) => (process.env[name] ?? '') === '');
  if (missing.length > 0) {
    throw new Error(`integration test needs ${missing.join(', ')}`);
  }
  return {
    bin: process.env['VAULTGATE_TEST_BW_BIN'] ?? 'bw',
    server: process.env['VAULTGATE_TEST_BW_SERVER'],
    clientId: process.env['VAULTGATE_TEST_BW_CLIENT_ID'] ?? '',
    clientSecret: process.env['VAULTGATE_TEST_BW_CLIENT_SECRET'] ?? '',
    masterPassword: process.env['VAULTGATE_TEST_BW_PASSWORD'] ?? '',
  };
}
