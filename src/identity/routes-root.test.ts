import { describe, expect, it } from 'vitest';

import { createHarness, setUpOperator } from '../test-support/identity-app.ts';

describe('GET /', () => {
  it('ID-23 sends an anonymous browser to the login page', async () => {
    const harness = createHarness();
    const response = await harness.browser().get('/');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('ID-23 sends a signed-in operator to the console’s home: Agents, or the home another layer names', async () => {
    const harness = createHarness();
    const { browser } = await setUpOperator(harness);
    const response = await browser.get('/');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account/agents');
    const computers = createHarness({ homePath: '/account/actions' });
    const signedIn = await setUpOperator(computers);
    const home = await signedIn.browser.get('/');
    expect(home.headers.get('location')).toBe('/account/actions');
  });

  it('ID-23 scopes the redirect to the bare root', async () => {
    const harness = createHarness();
    const stylesheet = await harness.browser().get('/static/vaultgate.css');
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('content-security-policy')).toBeNull();
  });
});
