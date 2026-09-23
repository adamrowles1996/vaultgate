import { type DestinationStream, type Logger, pino } from 'pino';

import type { LogLevel } from './config/index.ts';

export type { Logger } from 'pino';

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
  // ACT-53: the actions engine's injected values and credential documents, by field name.
  '*.injected',
  '*.injectedValues',
  '*.secret',
  '*.credential',
] as const;

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
