import { describe, expect, it } from 'vitest';

import { signedInOperator } from '../../test-support/actions-pages.ts';
import {
  BROKEN_ITEM,
  CODE_FORM,
  createCodePages,
  PRIVATE_REPO,
  PUBLIC_REPO,
} from '../../test-support/code-pages.ts';
import { FAKE_TOKEN } from '../../test-support/fake-github.ts';
import { compact } from '../../test-support/identity-app.ts';

import { checkCard } from './check-report.ts';
import { githubCheck, pageAccess } from './code-github.ts';

const CHECK = { ...CODE_FORM, intent: 'check' };

async function checked(
  fields: Readonly<Record<string, string>>,
  options: Parameters<typeof createCodePages>[0] = {},
) {
  const pages = createCodePages(options);
  const { browser, csrf } = await signedInOperator(pages.harness);
  const response = await browser.submit('/account/actions', { ...CHECK, ...fields, csrf });
  expect(response.status).toBe(200);
  return { ...pages, markup: compact(await response.text()) };
}

describe('Check without saving a Semble connection (ACT-120)', () => {
  it('ACT-118 ACT-120 asks GitHub for the repository with the chosen token and shows its default branch and visibility', async () => {
    const { markup, github, harness } = await checked({});
    expect(markup).toContain('<span class="pill pill-ok">Everything checks out</span>');
    expect(markup).toContain(
      'The token can read <span class="mono">acme/private-app</span> · default branch <span class="mono">main</span> · private',
    );
    expect(markup).toContain(
      'vaultgate asked GitHub about the repository and connected to nothing else.',
    );
    expect(markup).toContain('<span class="mono">api.github.com</span> resolves to');
    expect(markup).toContain('custom.AccessToken</span> is on the item');
    const asked = github.requests.find((request) =>
      request.url.endsWith('/repos/acme/private-app'),
    );
    expect(asked?.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
  });

  it('ACT-120 reads a public repository without a token', async () => {
    const { markup, github } = await checked({
      'credential.token_field': 'none',
      'destination.repository': PUBLIC_REPO.fullName,
    });
    expect(markup).toContain(
      'GitHub answers without a token for <span class="mono">acme/docs</span> · default branch <span class="mono">trunk</span> · public',
    );
    expect(github.requests.every((request) => request.headers['authorization'] === undefined)).toBe(
      true,
    );
  });

  it('ACT-120 says why GitHub would not answer, counted as a problem, and never shows the token', async () => {
    const { markup } = await checked({ 'credential.token_field': 'none' });
    expect(markup).toContain('<span class="pill pill-bad">1 problem</span>');
    expect(markup).toContain(
      'GitHub, asked without a token: GitHub has no such repository, or the token cannot read it (upstream_error, HTTP 404)',
    );
    const stale = await checked({ 'credential.token_field': 'password' });
    expect(stale.markup).toContain(
      'GitHub, asked with the token: GitHub has no such repository, or the token cannot read it (upstream_error, HTTP 404)',
    );
    const refused = await checked({}, { apiStatus: 401 });
    expect(refused.markup).toContain(
      'GitHub, asked with the token: GitHub refused the token (authentication_failed)',
    );
    expect(refused.markup).not.toContain('CANARY');
  });

  it('ACT-120 does not ask GitHub about a repository the rules refuse', async () => {
    const { markup, github } = await checked({ 'destination.repository': '../escape' });
    expect(markup).toContain(
      'GitHub was not asked: the repository or the token field is not valid.',
    );
    expect(github.requests.some((request) => request.url.includes('/repos/'))).toBe(false);
  });

  it('ACT-55 ACT-56 ACT-119 reads no token when api.github.com resolves to a refused address or not at all', async () => {
    const privateDns = await checked({}, { addresses: { 'api.github.com': ['10.0.0.9'] } });
    expect(privateDns.markup).toContain(
      'api.github.com resolved to an address vaultgate refuses (destination_refused)',
    );
    expect(privateDns.github.requests).toStrictEqual([]);
    const unresolved = await checked({}, { addresses: { 'api.github.com': [] } });
    expect(unresolved.markup).toContain('GitHub could not be reached (connection_failed)');
  });

  it('ACT-4 ACT-54 names the vault’s reason when the token cannot be read', async () => {
    const broken = await checked({
      'credential.item_id': BROKEN_ITEM.summary.id,
      'credential.token_field': 'password',
    });
    expect(broken.markup).toContain('the vault could not read that field (invalid_item)');
    const username = await checked({ 'credential.token_field': 'login.username' });
    expect(username.markup).toContain('the token field names no vault field (invalid_selector)');
    // A token kept as a TOTP seed is read as the code the vault computes from it.
    const totp = await checked({
      'credential.item_id': 'item-login',
      'credential.token_field': 'totp',
    });
    expect(totp.markup).toContain('GitHub, asked with the token: GitHub has no such repository');
    const missing = await checked({ 'credential.item_id': 'item-nope' });
    expect(missing.markup).toContain('the vault item is not there (not_found)');
  });

  it('ACT-118 ACT-120 checks an edit, and Check now on a saved connection asks GitHub again inside the ID-15 window only', async () => {
    const pages = createCodePages();
    const { browser, csrf } = await signedInOperator(pages.harness);
    await browser.submit('/account/actions', { ...CODE_FORM, csrf });
    const editCheck = await browser.submit('/account/actions/id-1', {
      ...CHECK,
      csrf,
      'destination.repository': PUBLIC_REPO.fullName,
    });
    const edit = compact(await editCheck.text());
    expect(edit).toContain('The token can read <span class="mono">acme/docs</span>');
    const now = await browser.submit('/account/actions/id-1/check', { csrf });
    expect(now.status).toBe(200);
    expect(compact(await now.text())).toContain(
      `The token can read <span class="mono">${PRIVATE_REPO.fullName}</span>`,
    );
    pages.harness.identity.advance(6 * 60_000);
    const again = await browser.submit('/account/actions/id-1/check', { csrf });
    const later = compact(await again.text());
    expect(later).toContain('GitHub was not asked: unlock editing to let vaultgate use the token.');
    expect(later).toContain('Nothing was saved and nothing connected.');
  });

  it('ACT-120 asks nothing of a connection of another kind', async () => {
    const pages = createCodePages();
    const answer = await githubCheck(
      {
        github: { fetch: pages.github.fetch, lookup: () => Promise.resolve([]), userAgent: 'x' },
        vault: pages.vault,
      },
      {
        connector: 'http',
        destination: {},
        credential: { item_id: 'item-login', mapping: {} },
        isReauthenticated: true,
      },
    );
    expect(answer).toBeUndefined();
    expect(
      checkCard({ at: 0, report: { problems: [], endpoints: [], rules: [] } }).markup,
    ).not.toContain('GitHub');
  });

  it('ACT-104 ACT-119 gives a page’s GitHub exchange no archive host and keeps nothing a redirect hands back', () => {
    const access = pageAccess(
      {
        fetch: () => Promise.reject(new Error('unused')),
        lookup: () => Promise.resolve([]),
        userAgent: 'vaultgate/test',
      },
      '140.82.112.6',
      undefined,
    );
    expect(access).toMatchObject({
      apiAddress: '140.82.112.6',
      archiveAddress: '',
      token: undefined,
    });
    const redirect = Buffer.from('https://codeload.github.com/x', 'utf8');
    access.capture('archive_url', redirect);
    expect(access).not.toHaveProperty('captured');
    expect(access.signal.aborted).toBe(false);
  });
});
