import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.ts';

function collectingSink(): { sink: Writable; lines: () => readonly Record<string, unknown>[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    sink,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('emits JSON lines tagged with the service name and an ISO timestamp', () => {
    const { sink, lines } = collectingSink();
    createLogger('info', sink).info({ requestId: 'abc' }, 'hello');
    const [line] = lines();
    expect(line).toMatchObject({ service: 'vaultgate', requestId: 'abc', msg: 'hello' });
    expect(line?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('honours the configured level', () => {
    const { sink, lines } = collectingSink();
    const logger = createLogger('warn', sink);
    logger.info('dropped');
    logger.warn('kept');
    expect(lines().map((line) => line['msg'])).toEqual(['kept']);
  });

  it('redacts credentials wherever they appear in a log object', () => {
    const { sink, lines } = collectingSink();
    createLogger('info', sink).info(
      {
        req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1' } },
        login: { password: 'hunter2', totp: '123456' },
        grant: { accessToken: 'vg_at_x', refreshToken: 'vg_rt_x' },
      },
      'login',
    );
    const serialised = JSON.stringify(lines()[0]);
    for (const secret of ['Bearer secret', 'sid=1', 'hunter2', '123456', 'vg_at_x', 'vg_rt_x']) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).toContain('[REDACTED]');
  });
});
