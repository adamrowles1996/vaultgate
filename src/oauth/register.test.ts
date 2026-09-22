import { describe, expect, it } from 'vitest';

import { createOAuthHarness, jsonBody, parseJson } from '../test-support/oauth-harness.ts';

const METADATA = { redirect_uris: ['https://agent.example.com/cb'], client_name: 'Agent' };

describe('POST /oauth/register', () => {
  it('OAUTH-11 answers 201 with a vg_c_ client id, issued-at and the echoed metadata; audits it', async () => {
    const harness = createOAuthHarness();
    const response = await harness.exchange('/oauth/register', jsonBody(METADATA));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const body = parseJson(response);
    expect(body['client_id']).toMatch(/^vg_c_[\w-]{43}$/);
    expect(body['client_id_issued_at']).toBe(1_700_000_000);
    expect(body['client_name']).toBe('Agent');
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(body).not.toHaveProperty('client_secret');
    expect(harness.audit).toHaveLength(1);
    expect(harness.audit[0]).toMatchObject({
      action: 'client_registered',
      clientId: body['client_id'],
      ip: '203.0.113.7',
    });
  });

  it('OAUTH-5 rejects a confidential client with invalid_client_metadata', async () => {
    const harness = createOAuthHarness();
    const response = await harness.exchange(
      '/oauth/register',
      jsonBody({ ...METADATA, token_endpoint_auth_method: 'client_secret_post' }),
    );
    expect(response.status).toBe(400);
    expect(parseJson(response)).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('OAUTH-11 rejects a body that is not JSON, not typed as JSON, or over 16 KiB', async () => {
    const harness = createOAuthHarness();
    const untyped = await harness.exchange('/oauth/register', { method: 'POST', body: '{}' });
    expect(parseJson(untyped)).toMatchObject({
      error_description: 'the body must be application/json',
    });
    const malformed = await harness.exchange('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(parseJson(malformed)).toMatchObject({ error_description: 'the body is not valid JSON' });
    const huge = await harness.exchange(
      '/oauth/register',
      jsonBody({ ...METADATA, padding: 'x'.repeat(17 * 1024) }),
    );
    expect(parseJson(huge)).toMatchObject({ error_description: 'the request body is too large' });
  });

  it('OAUTH-11 limits registrations to 10 per hour per ip with Retry-After', async () => {
    const harness = createOAuthHarness();
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await harness.exchange('/oauth/register', jsonBody(METADATA));
      statuses.push(response.status);
    }
    expect(statuses).toStrictEqual([...Array.from({ length: 10 }, () => 201), 429]);
    const throttled = await harness.exchange('/oauth/register', jsonBody(METADATA));
    expect(throttled.headers.get('retry-after')).toBe('360');
    harness.advance(3_600_000);
    const later = await harness.exchange('/oauth/register', jsonBody(METADATA));
    expect(later.status).toBe(201);
  });

  it('OPS-6 keys the limit on X-Forwarded-For only when the proxy is trusted', async () => {
    const trusted = createOAuthHarness({ trustProxy: true });
    for (let index = 0; index < 10; index += 1) {
      await trusted.request(
        '/oauth/register',
        jsonBody(METADATA, { 'x-forwarded-for': '198.51.100.1' }),
      );
    }
    const other = await trusted.exchange(
      '/oauth/register',
      jsonBody(METADATA, { 'x-forwarded-for': '198.51.100.2' }),
    );
    expect(other.status).toBe(201);
    const same = await trusted.exchange(
      '/oauth/register',
      jsonBody(METADATA, { 'x-forwarded-for': '198.51.100.1' }),
    );
    expect(same.status).toBe(429);
  });
});
