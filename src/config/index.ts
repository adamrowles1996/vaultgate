import { fail, ok, type Result } from '../result.ts';

import { type ActionsConfig, actionsWarnings } from './actions.ts';
import { type Environment, withoutEmptyValues } from './environment.ts';
import { environmentSchema, type LogLevel, type ParsedEnvironment } from './schema.ts';
import {
  readSecretFileFromDisk,
  resolveSecretFiles,
  type SecretFileReader,
} from './secret-files.ts';

import type { PreregisteredClient } from './primitives.ts';

export type { ActionsConfig } from './actions.ts';
export type { Environment } from './environment.ts';
export type { LogLevel } from './schema.ts';

interface BitwardenConfig {
  readonly server: string | undefined;
  readonly bin: string;
  /**
  First-boot seed; the account page's stored connection takes precedence (CFG-5).
  */
  readonly clientId: string | undefined;
  readonly syncIntervalMs: number;
}

/**
Secret material, kept together so it is masked as one unit when described.
*/
interface Secrets {
  readonly secretKey: Buffer;
  readonly masterPassword: string | undefined;
  readonly clientSecret: string | undefined;
  readonly bootstrapToken: string | undefined;
}

export interface Config {
  readonly publicUrl: string;
  readonly host: string;
  readonly port: number;
  readonly trustProxy: boolean;
  /**
  Trusted proxies in front of the listener; meaningful only with `trustProxy`.
  */
  readonly trustedProxyHops: number;
  readonly allowedOrigins: readonly string[];
  readonly dataDir: string;
  readonly enableWriteScope: boolean;
  readonly oauthClients: readonly PreregisteredClient[];
  readonly accessTokenTtlMs: number;
  readonly refreshTokenTtlMs: number;
  readonly sessionTtlMs: number;
  readonly auditRetentionDays: number;
  readonly sqliteNetworkFs: boolean;
  readonly logLevel: LogLevel;
  readonly bitwarden: BitwardenConfig;
  readonly actions: ActionsConfig;
  readonly secrets: Secrets;
}

export interface LoadedConfig {
  readonly config: Config;
  /**
  Non-fatal findings the operator should see once at start-up.
  */
  readonly warnings: readonly string[];
}

export interface LoadOptions {
  readonly readSecretFile?: SecretFileReader;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function toConfig(data: ParsedEnvironment): Config {
  return {
    publicUrl: data.VAULTGATE_PUBLIC_URL,
    host: data.VAULTGATE_HOST,
    port: data.VAULTGATE_PORT,
    trustProxy: data.VAULTGATE_TRUST_PROXY,
    trustedProxyHops: data.VAULTGATE_TRUSTED_PROXY_HOPS,
    allowedOrigins: data.VAULTGATE_ALLOWED_ORIGINS,
    dataDir: data.VAULTGATE_DATA_DIR,
    enableWriteScope: data.VAULTGATE_ENABLE_WRITE_SCOPE,
    oauthClients: data.VAULTGATE_OAUTH_CLIENTS,
    accessTokenTtlMs: data.VAULTGATE_ACCESS_TOKEN_TTL,
    refreshTokenTtlMs: data.VAULTGATE_REFRESH_TOKEN_TTL,
    sessionTtlMs: data.VAULTGATE_SESSION_TTL,
    auditRetentionDays: data.VAULTGATE_AUDIT_RETENTION_DAYS,
    sqliteNetworkFs: data.VAULTGATE_SQLITE_NETWORK_FS,
    logLevel: data.VAULTGATE_LOG_LEVEL,
    bitwarden: {
      server: data.VAULTGATE_BW_SERVER,
      bin: data.VAULTGATE_BW_BIN,
      clientId: data.VAULTGATE_BW_CLIENT_ID,
      syncIntervalMs: data.VAULTGATE_BW_SYNC_INTERVAL,
    },
    actions: {
      enabled: data.VAULTGATE_ENABLE_ACTIONS,
      connectors: {
        http: data.VAULTGATE_ACTIONS_ENABLE_HTTP,
        sql: data.VAULTGATE_ACTIONS_ENABLE_SQL,
        ssh: data.VAULTGATE_ACTIONS_ENABLE_SSH,
        winrm: data.VAULTGATE_ACTIONS_ENABLE_WINRM,
        browser: data.VAULTGATE_ACTIONS_ENABLE_BROWSER,
      },
      browserCdpUrl: data.VAULTGATE_ACTIONS_BROWSER_CDP_URL,
      allowAnyCommand: data.VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND,
    },
    secrets: {
      secretKey: data.VAULTGATE_SECRET_KEY,
      masterPassword: data.VAULTGATE_BW_PASSWORD,
      clientSecret: data.VAULTGATE_BW_CLIENT_SECRET,
      bootstrapToken: data.VAULTGATE_BOOTSTRAP_TOKEN,
    },
  };
}

/**
 * Validates the whole environment in one pass and reports every problem,
 * not just the first. `<NAME>_FILE` variables are resolved first.
 */
export function loadConfig(
  environment: Environment,
  options: LoadOptions = {},
): Result<LoadedConfig, ConfigError> {
  const resolved = resolveSecretFiles(
    withoutEmptyValues(environment),
    options.readSecretFile ?? readSecretFileFromDisk,
  );
  const parsed = environmentSchema.safeParse(resolved.environment);
  if (!parsed.success) {
    const schemaIssues = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
    );
    return fail(new ConfigError([...resolved.issues, ...schemaIssues]));
  }
  if (resolved.issues.length > 0) {
    return fail(new ConfigError(resolved.issues));
  }
  const config = toConfig(parsed.data);
  return ok({ config, warnings: [...resolved.warnings, ...actionsWarnings(config.actions)] });
}

function masked(value: string | Buffer | undefined): '[set]' | '[unset]' {
  return value === undefined ? '[unset]' : '[set]';
}

/**
The configuration as safe to log: every secret replaced by `[set]`/`[unset]`.
*/
export function describeConfig(config: Config): Record<string, unknown> {
  const { secrets, ...rest } = config;
  return {
    ...rest,
    secrets: {
      secretKey: masked(secrets.secretKey),
      masterPassword: masked(secrets.masterPassword),
      clientSecret: masked(secrets.clientSecret),
      bootstrapToken: masked(secrets.bootstrapToken),
    },
  };
}
