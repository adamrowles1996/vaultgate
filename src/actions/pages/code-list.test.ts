import { describe, expect, it, vi } from 'vitest';

import { createHttpTarget } from '../../test-support/actions-fixtures.ts';
import { signedInOperator } from '../../test-support/actions-pages.ts';
import {
  CODE_FORM,
  createCodePages,
  PUBLIC_REPO,
  STALE_TOKEN,
} from '../../test-support/code-pages.ts';
import { FAKE_ARCHIVE_TOKEN, FAKE_TOKEN } from '../../test-support/fake-github.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';
import { CANARIES } from '../../test-support/vault-fixture.ts';

import { allowsOf } from './summary.ts';

const PUBLIC_FORM = {
  ...CODE_FORM,
  name: 'docs',
  'destination.repository': PUBLIC_REPO.fullName,
  'destination.ref': 'trunk',
  'credential.token_field': 'none',
  'policy.content.config': '',
  'policy.allow_read': '',
};

describe('Semble connections in the Connections list (ACT-5, ACT-119)', () => {
  it('ACT-5 ACT-119 groups code targets under their kind, with the repository, the token field and what they allow', async () => {
    const pages = createCodePages();
    const { browser, csrf } = await signedInOperator(pages.harness);
    await browser.submit('/account/actions', { ...CODE_FORM, csrf });
    await browser.submit('/account/actions', { ...PUBLIC_FORM, csrf });
    await createHttpTarget(pages.harness.actions, { name: 'api' });
    const markup = compact(await pageText(browser, '/account/actions'));
    expect(markup).toContain('>Semble · GitHub code search <span class="count">2</span>');
    expect(markup).toContain('code_search · code_find_related · code_read');
    expect(markup).toContain(
      '<span class="mono">acme/private-app</span><span class="cell-sub">GitHub · default branch</span>',
    );
    expect(markup).toContain(
      '<span class="mono">acme/docs@trunk</span><span class="cell-sub">GitHub · configured ref</span>',
    );
    expect(markup).toContain('custom.AccessToken</span>');
    expect(markup).toContain('<span class="cell-sub">No token: a public repository</span>');
    expect(markup).toContain('<span>code, docs, config, read files</span>');
    expect(markup).toContain('<span>code, docs</span>');
    const sidebar = markup.slice(markup.indexOf('<aside'), markup.indexOf('</aside>'));
    expect(sidebar).toContain('href="/account/actions?kind=code"');
    const filtered = compact(await pageText(browser, '/account/actions?kind=code'));
    expect(filtered).toContain('acme/docs@trunk');
    expect(filtered).not.toContain('api.example.com');
    const page = compact(await pageText(browser, '/account/actions/id-2'));
    expect(page).toContain('<dt>Token</dt><dd>No token: a public repository</dd>');
    expect(page).toContain('<span class="tag tag-plain">Semble · GitHub code search</span>');
    expect(page).toContain('href="/account/actions?kind=code">Semble · GitHub code search</a>');
    expect(page).toContain('Nothing to confirm: the policy allows reads only');
  });

  it('ACT-5 says what a code policy allows, and nothing of one out of shape', () => {
    expect(allowsOf('code', { content: ['code'], allow_read: false })).toBe('code');
    expect(allowsOf('code', { content: ['docs', 'config'], allow_read: true })).toBe(
      'docs, config, read files',
    );
    expect(allowsOf('code', {})).toBe('');
    expect(allowsOf('sql', {})).toBe('');
    expect(allowsOf('ssh', { allowed_commands: 'uptime' })).toBe('');
  });
});

describe('the token never leaves the vault for a page (ACT-53, ACT-119)', () => {
  it('ACT-119 ACT-120 ACT-53 draws, redirects and logs no token on any page, check, save or rebuild', async () => {
    const pages = createCodePages();
    const { harness, sidecar } = pages;
    const { browser, csrf } = await signedInOperator(harness);
    const seen: string[] = [];
    const record = async (response: Response) => {
      seen.push(response.headers.get('location') ?? '', await response.text());
    };
    await record(
      await browser.get('/account/actions/new?connector=code&kind=code&item=item-github'),
    );
    await record(await browser.submit('/account/actions', { ...CODE_FORM, csrf, intent: 'check' }));
    await record(await browser.submit('/account/actions', { ...CODE_FORM, csrf }));
    await vi.waitFor(() => {
      expect(sidecar.snapshots.size).toBe(1);
    });
    await record(await browser.get('/account/actions/id-1'));
    await record(await browser.get('/account/actions/id-1?check=now'));
    await record(await browser.get('/account/actions/id-1/edit'));
    await record(
      await browser.submit('/account/actions/id-1', { ...CODE_FORM, csrf, intent: 'check' }),
    );
    await record(await browser.submit('/account/actions/id-1/rebuild', { csrf }));
    await vi.waitFor(() => {
      expect(sidecar.builds).toHaveLength(2);
    });
    await record(await browser.get('/account/actions'));
    const logged = JSON.stringify([
      harness.actions.logged(),
      harness.identity.logged(),
      harness.actions.audit,
      harness.identity.audits,
    ]);
    for (const canary of [FAKE_TOKEN, STALE_TOKEN, FAKE_ARCHIVE_TOKEN, ...CANARIES]) {
      expect(seen.filter((text) => text.includes(canary))).toStrictEqual([]);
      expect(logged).not.toContain(canary);
    }
    expect(seen.join('\n')).toContain('The token can read');
  });
});
