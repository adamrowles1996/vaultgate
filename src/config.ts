import { z } from 'zod';

import { fail, ok, type Result } from './result.ts';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const MIN_PORT = 1;
const MAX_PORT = 65_535;
const DEFAULT_PORT = 8080;

/**
 * Every setting the process reads from its environment, validated once at
 * start-up. Defaults bind to loopback: exposing the server is an explicit act.
 */
const environmentSchema = z.object({
  VAULTGATE_HOST: z.string().min(1).default('127.0.0.1'),
  VAULTGATE_PORT: z.coerce.number().int().min(MIN_PORT).max(MAX_PORT).default(DEFAULT_PORT),
  VAULTGATE_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

export function loadConfig(environment: Environment): Result<Config, ConfigError> {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    return fail(
      new ConfigError(
        parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
      ),
    );
  }
  return ok({
    host: parsed.data.VAULTGATE_HOST,
    port: parsed.data.VAULTGATE_PORT,
    logLevel: parsed.data.VAULTGATE_LOG_LEVEL,
  });
}
