import { type DestinationStream, type Logger, pino } from 'pino';

import type { LogLevel } from './config.ts';

/**
 * Log fields that must never reach a log sink, whatever a caller passes.
 * Vault material is additionally kept out of log statements by construction;
 * this list is the backstop for headers and error payloads.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.masterPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.totp',
] as const;

export type { Logger };

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'vaultgate' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
    },
    destination,
  );
}
