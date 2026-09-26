import { describe, expect, it, vi } from 'vitest';

import { signedInOperator } from '../../test-support/actions-pages.ts';
import { CODE_FORM, createCodePages, GITHUB_ITEM_ID } from '../../test-support/code-pages.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';

const NEW_CODE = `/account/actions/new?connector=code&kind=code&item=${GITHUB_ITEM_ID}`;

/**
The pages harness with a saved Semble connection, and a spy on every secret the vault is asked for.
*/
async function withConnection() {
  const pages = createCodePages();
  const operator = await signedInOperator(pages.harness);
  const created = await operator.browser.submit('/account/actions', {
    ...CODE_FORM,
    csrf: operator.csrf,
  });
  expect(created.status).toBe(303);
  await pages.harness.actions.clock.settle();
  const secrets = vi.spyOn(pages.vault, 'getSecret');
  const asked = pages.github.requests.length;
  return { ...pages, ...operator, secrets, asked };
}

describe('no page load reads a secret (ACT-119, ACT-120)', () => {
  it('ACT-119 ID-18 a GET of the create form or the edit form, token field and all, reads no secret and asks GitHub nothing', async () => {
    const { browser, secrets, github, asked } = await withConnection();
    const forms = [
      NEW_CODE,
      `${NEW_CODE}&credential.token_field=password`,
      '/account/actions/id-1/edit',
      `/account/actions/id-1/edit?item=${GITHUB_ITEM_ID}`,
    ];
    for (const path of forms) {
      expect(compact(await pageText(browser, path))).toContain(
        'press Check without saving to list the repositories it can read.',
      );
    }
    expect(secrets).not.toHaveBeenCalled();
    expect(github.requests).toHaveLength(asked);
  });

  it('ACT-120 ID-18 a GET of a target page, with or without ?check=now, reads no secret and asks GitHub nothing', async () => {
    const { browser, secrets, github, asked } = await withConnection();
    for (const path of ['/account/actions/id-1', '/account/actions/id-1?check=now']) {
      const markup = compact(await pageText(browser, path));
      expect(markup).toContain('<form method="post" action="/account/actions/id-1/check">');
      expect(markup).not.toContain('id="check"');
    }
    expect(secrets).not.toHaveBeenCalled();
    expect(github.requests).toHaveLength(asked);
  });

  it('ACT-120 ID-18 Check now reads the token only on a POST that carries the synchroniser token', async () => {
    const { browser, csrf, secrets, github, asked } = await withConnection();
    const forged = await browser.submit('/account/actions/id-1/check', { csrf: 'not-the-token' });
    expect(forged.status).toBe(403);
    expect(secrets).not.toHaveBeenCalled();
    const checked = await browser.submit('/account/actions/id-1/check', { csrf });
    expect(compact(await checked.text())).toContain(
      'The token can read <span class="mono">acme/private-app</span>',
    );
    expect(secrets).toHaveBeenCalledTimes(1);
    expect(github.requests.length).toBeGreaterThan(asked);
  });
});
