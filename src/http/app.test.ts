import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger.ts';

import { createApp, type Readiness } from './app.ts';

const READY: Readiness = { ready: true, failing: [] };

function appWithLogSink(readiness: () => Readiness = () => READY): {
  app: ReturnType<typeof createApp>;
  logged: () => string;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    app: createApp({ logger: createLogger('error', sink), readiness }),
    logged: () => chunks.join(''),
  };
}

describe('createApp', () => {
  it('answers the liveness probe', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('answers the readiness probe', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('OPS-4 answers 503 naming the failing components when not ready', async () => {
    const { app } = appWithLogSink(() => ({ ready: false, failing: ['store'] }));
    const response = await app.request('/readyz');
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({ status: 'unavailable', failing: ['store'] });
  });

  it('sets a request id and hardening headers on every response', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/healthz');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const { app } = appWithLogSink();
    const response = await app.request('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: 'not_found' });
  });

  it('logs and masks unhandled errors', async () => {
    const { app, logged } = appWithLogSink();
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    const response = await app.request('/boom');
    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({ error: 'internal_error' });
    expect(logged()).toContain('kaboom');
    expect(logged()).toContain('unhandled request error');
  });
});
