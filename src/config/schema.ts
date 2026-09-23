import { z } from 'zod';

import { cdpUrlSchema } from './actions.ts';
import { durationSchema } from './duration.ts';
import {
  bitwardenServerSchema,
  booleanSchema,
  originListSchema,
  preregisteredClientsSchema,
  publicUrlSchema,
  secretKeySchema,
} from './primitives.ts';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const MIN_PORT = 1;
const MAX_PORT = 65_535;
const DEFAULT_PORT = 8080;
const MIN_BOOTSTRAP_TOKEN_LENGTH = 16;
const MIN_PROXY_HOPS = 1;
const MAX_PROXY_HOPS = 10;
const MAX_AUDIT_RETENTION_DAYS = 3650;
const DEFAULT_AUDIT_RETENTION_DAYS = 365;

/**
 * Every setting the process reads from its environment (spec §08). Defaults
 * bind to loopback: exposing the server is an explicit act.
 */
const baseEnvironmentSchema = z.object({
  VAULTGATE_PUBLIC_URL: publicUrlSchema,
  VAULTGATE_HOST: z.string().min(1).default('127.0.0.1'),
  VAULTGATE_PORT: z.coerce.number().int().min(MIN_PORT).max(MAX_PORT).default(DEFAULT_PORT),
  VAULTGATE_TRUST_PROXY: booleanSchema('false'),
  // Which X-Forwarded-For entry is the client, counted from the right (OPS-6).
  VAULTGATE_TRUSTED_PROXY_HOPS: z.coerce
    .number()
    .int()
    .min(MIN_PROXY_HOPS)
    .max(MAX_PROXY_HOPS)
    .default(MIN_PROXY_HOPS),
  VAULTGATE_ALLOWED_ORIGINS: originListSchema,
  VAULTGATE_DATA_DIR: z.string().min(1).default('./data'),
  VAULTGATE_SECRET_KEY: secretKeySchema,
  // Seeds for the first boot only (CFG-5): once the operator saves a vault
  // connection on the account page the stored row wins and these are ignored.
  VAULTGATE_BW_PASSWORD: z.string().min(1).optional(),
  VAULTGATE_BW_CLIENT_ID: z.string().min(1).optional(),
  VAULTGATE_BW_CLIENT_SECRET: z.string().min(1).optional(),
  VAULTGATE_BW_SERVER: bitwardenServerSchema,
  VAULTGATE_BW_BIN: z.string().min(1).default('bw'),
  VAULTGATE_BW_SYNC_INTERVAL: durationSchema({ min: '1m', max: '24h', fallback: '15m' }),
  VAULTGATE_ENABLE_WRITE_SCOPE: booleanSchema('false'),
  VAULTGATE_OAUTH_CLIENTS: preregisteredClientsSchema,
  VAULTGATE_BOOTSTRAP_TOKEN: z.string().min(MIN_BOOTSTRAP_TOKEN_LENGTH).optional(),
  VAULTGATE_ACCESS_TOKEN_TTL: durationSchema({ min: '5m', max: '24h', fallback: '1h' }),
  VAULTGATE_REFRESH_TOKEN_TTL: durationSchema({ min: '1h', max: '365d', fallback: '30d' }),
  VAULTGATE_SESSION_TTL: durationSchema({ min: '15m', max: '7d', fallback: '12h' }),
  VAULTGATE_AUDIT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_AUDIT_RETENTION_DAYS)
    .default(DEFAULT_AUDIT_RETENTION_DAYS),
  VAULTGATE_SQLITE_NETWORK_FS: booleanSchema('false'),
  VAULTGATE_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // The actions layer (spec §13.14): a master switch, one switch per connector.
  VAULTGATE_ENABLE_ACTIONS: booleanSchema('false'),
  VAULTGATE_ACTIONS_ENABLE_HTTP: booleanSchema('false'),
  VAULTGATE_ACTIONS_ENABLE_SQL: booleanSchema('false'),
  VAULTGATE_ACTIONS_ENABLE_SSH: booleanSchema('false'),
  VAULTGATE_ACTIONS_ENABLE_WINRM: booleanSchema('false'),
  VAULTGATE_ACTIONS_ENABLE_BROWSER: booleanSchema('false'),
  VAULTGATE_ACTIONS_BROWSER_CDP_URL: cdpUrlSchema,
  VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND: booleanSchema('false'),
});

/**
 * Cross-field rules the object schema cannot express column by column.
 */
export const environmentSchema = baseEnvironmentSchema.superRefine((data, context) => {
  if (
    data.VAULTGATE_ACTIONS_ENABLE_BROWSER &&
    data.VAULTGATE_ACTIONS_BROWSER_CDP_URL === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['VAULTGATE_ACTIONS_BROWSER_CDP_URL'],
      message: 'is required when VAULTGATE_ACTIONS_ENABLE_BROWSER is true',
    });
  }
});

export type ParsedEnvironment = z.output<typeof environmentSchema>;
