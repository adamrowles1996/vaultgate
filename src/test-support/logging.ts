import { Writable } from 'node:stream';

import { createLogger, type Logger } from '../logger.ts';

export interface CapturedLogger {
  readonly logger: Logger;
  /**
  Every line logged so far, parsed back from JSON.
  */
  readonly lines: () => readonly Record<string, unknown>[];
}

/**
A logger whose output is kept in memory so tests can assert on what was logged.
*/
export function captureLogger(): CapturedLogger {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    logger: createLogger('trace', sink),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
