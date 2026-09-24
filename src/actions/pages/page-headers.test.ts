import { describe, expect, it } from 'vitest';

import { createHttpTarget } from '../../test-support/actions-fixtures.ts';
import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';

describe('the headers and notices of every Actions page', () => {
  it('ID-19 ACT-6 every Actions page carries the strict CSP and no-store, whatever order the layer is mounted in', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const { browser } = await signedInOperator(harness);
    const pages = [
      '/account/actions/new?connector=http',
      `/account/actions/${target.id}`,
      `/account/actions/${target.id}/calls`,
      '/account/actions/unexpected',
    ];
    for (const path of pages) {
      const response = await browser.get(path);
      expect([path, response.status]).toStrictEqual([path, 200]);
      expect([path, response.headers.get('content-security-policy')]).toStrictEqual([
        path,
        "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; " +
          "frame-ancestors 'none'; base-uri 'none'",
      ]);
      expect([path, response.headers.get('cache-control')]).toStrictEqual([path, 'no-store']);
    }
  });

  it('ID-24 a notice naming an inherited property of Object renders the page rather than crashing it', async () => {
    const harness = createPagesHarness();
    const target = await createHttpTarget(harness.actions);
    const { browser } = await signedInOperator(harness);
    for (const notice of ['constructor', 'toString', '__proto__', 'nonsense']) {
      const response = await browser.get(`/account/actions/${target.id}?notice=${notice}`);
      expect([notice, response.status]).toStrictEqual([notice, 200]);
      expect(await response.text()).not.toContain('function Object');
    }
  });
});
