import { describe, expect, it } from 'vitest';

import { signedInOperator } from '../../test-support/actions-pages.ts';
import {
  CODE_FORM,
  createCodePages,
  GITHUB_ITEM_ID,
  PRIVATE_REPO,
  PUBLIC_REPO,
} from '../../test-support/code-pages.ts';
import { FAKE_TOKEN } from '../../test-support/fake-github.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';
import { unwrapOk } from '../../test-support/result.ts';

import { codeForm } from './code-form.ts';
import { repoOffer } from './code-github.ts';
import { applyChoices, describeFailure, repoSource } from './repo-source.ts';

const NEW_CODE = `/account/actions/new?connector=code&kind=code&item=${GITHUB_ITEM_ID}`;
const WITH_ACCESS_TOKEN = { ...CODE_FORM, intent: 'check' };

describe('the repositories the token can read (ACT-119)', () => {
  it('ACT-119 lists them beside the repository field once the item and a token field are chosen, asking GitHub with that token only', async () => {
    const { harness, github } = createCodePages();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      ...WITH_ACCESS_TOKEN,
      csrf,
      'destination.repository': '',
    });
    const markup = compact(await response.text());
    expect(markup).toContain('<select name="repository_from">');
    expect(markup).toContain('<option value="" selected>No: use what is typed above</option>');
    expect(markup).toContain(
      '<option value="acme/private-app" >acme/private-app · private</option>',
    );
    expect(markup).toContain('<option value="acme/docs" >acme/docs · public</option>');
    expect(markup).toContain('2 repositories from');
    // The list can fill the field, so the browser does not insist on a typed name.
    expect(markup).toContain(
      '<input name="destination.repository" value="" autocomplete="off"  />',
    );
    const listing = github.requests.filter((request) => request.url.includes('/user/repos'));
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({
      url: 'https://api.github.com/user/repos?per_page=100&page=1&sort=full_name',
      address: '93.184.216.34',
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'user-agent': 'vaultgate/test' },
    });
    expect(
      github.requests.every((request) => request.url.startsWith('https://api.github.com/')),
    ).toBe(true);
  });

  it('ACT-119 shows why a token could not list them, by its code, and asks for a typed name', async () => {
    const { harness } = createCodePages();
    const { browser } = await signedInOperator(harness);
    const markup = compact(await pageText(browser, NEW_CODE));
    expect(markup).toContain(
      'The token’s repositories could not be listed: GitHub refused the token (authentication_failed).',
    );
    // Not required in the browser: the list of another token field comes back with a check.
    expect(markup).toContain(
      '<input name="destination.repository" value="" autocomplete="off"  />',
    );
    expect(markup).not.toContain('name="repository_from"');
  });

  it('ACT-119 lists nothing without a token, and nothing outside a code form', async () => {
    const { harness, github } = createCodePages();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      ...WITH_ACCESS_TOKEN,
      csrf,
      'credential.token_field': 'none',
      'destination.repository': PUBLIC_REPO.fullName,
    });
    const markup = compact(await response.text());
    expect(markup).toContain('<small>No token: type the public repository as owner/name.</small>');
    expect(github.requests.some((request) => request.url.includes('/user/repos'))).toBe(false);
    const http = compact(
      await pageText(browser, '/account/actions/new?connector=http&item=item-login'),
    );
    expect(http).not.toContain('repository_from');
  });

  it('ACT-2 ACT-119 copies the chosen repository into the connection, and refuses a typed one that differs', async () => {
    const { harness } = createCodePages();
    const { browser, csrf } = await signedInOperator(harness);
    const conflict = await browser.submit('/account/actions', {
      ...CODE_FORM,
      csrf,
      'destination.repository': 'someone/else',
      repository_from: PRIVATE_REPO.fullName,
    });
    expect(conflict.status).toBe(400);
    expect(compact(await conflict.text())).toContain(
      'a repository is typed here and another is chosen from the token’s list; keep one of them',
    );
    const chosen = await browser.submit('/account/actions', {
      ...CODE_FORM,
      csrf,
      'destination.repository': '',
      repository_from: PRIVATE_REPO.fullName,
    });
    expect(chosen.status).toBe(303);
    expect(harness.actions.engine.targets.get('id-1')?.destination).toStrictEqual({
      repository: 'acme/private-app',
    });
    const same = await browser.submit('/account/actions', {
      ...CODE_FORM,
      csrf,
      name: 'docs',
      'destination.repository': 'Acme/Docs',
      repository_from: PUBLIC_REPO.fullName,
    });
    expect(same.status).toBe(303);
    expect(harness.actions.engine.targets.get('id-2')?.destination).toStrictEqual({
      repository: 'acme/docs',
    });
  });

  it('ACT-119 keeps the chosen repository selected when a form comes back, and says when GitHub lists none', () => {
    const field = {
      document: 'destination',
      name: 'repository',
      label: 'Repository',
      kind: 'text',
      offered: 'repositories',
    } as const;
    const values = new Map([['repository_from', 'acme/docs']]);
    const listed = repoSource(
      field,
      { state: 'listed', repositories: [{ fullName: 'acme/docs', isPrivate: false }] },
      values,
    ).markup;
    expect(listed).toContain('<option value="acme/docs" selected>acme/docs · public</option>');
    expect(listed).toContain('1 repository from');
    const none = repoSource(field, { state: 'listed', repositories: [] }, values).markup;
    expect(none).toContain('GitHub lists no repository for this token');
    expect(repoSource(field, { state: 'none' }, values).markup).toBe('');
    const reference = { document: 'destination', name: 'ref', label: 'Ref', kind: 'text' } as const;
    expect(repoSource(reference, { state: 'no-token' }, values).markup).toBe('');
  });

  it('ACT-119 lists with the schema’s default field when a form names none, and takes a choice with nothing typed', async () => {
    const pages = createCodePages();
    const summary = unwrapOk(await pages.vault.getItem(GITHUB_ITEM_ID));
    const offer = await repoOffer(
      {
        github: {
          fetch: pages.github.fetch,
          lookup: () => Promise.resolve(['140.82.112.6']),
          userAgent: 'x',
        },
        vault: pages.vault,
      },
      {
        form: codeForm,
        values: new Map(),
        item: { state: 'found', summary, changeHref: '/x' },
        isReauthenticated: true,
      },
    );
    expect(offer).toStrictEqual({ state: 'failed', failure: { code: 'authentication_failed' } });
    const locked = await repoOffer(
      {
        github: { fetch: pages.github.fetch, lookup: () => Promise.resolve([]), userAgent: 'x' },
        vault: pages.vault,
      },
      {
        form: codeForm,
        values: new Map(),
        item: { state: 'found', summary, changeHref: '/x' },
        isReauthenticated: false,
      },
    );
    expect(locked).toStrictEqual({ state: 'none' });
    const applied = applyChoices(codeForm, new Map([['repository_from', 'acme/docs']]));
    expect(applied.values.get('destination.repository')).toBe('acme/docs');
    expect(applied.problems).toStrictEqual([]);
  });

  it('ACT-119 ACT-54 words each failure for the operator, with its code and GitHub’s status', () => {
    expect(describeFailure({ code: 'upstream_error', status: 404 })).toBe(
      'GitHub has no such repository, or the token cannot read it (upstream_error, HTTP 404)',
    );
    expect(describeFailure({ code: 'upstream_error', status: 500 })).toBe(
      'GitHub answered with an error (upstream_error, HTTP 500)',
    );
    expect(describeFailure({ code: 'timeout' })).toBe('GitHub did not answer in time (timeout)');
    expect(describeFailure({ code: 'constructor' })).toBe('constructor');
    expect(describeFailure({ code: 'something_new', status: 418 })).toBe('something_new, HTTP 418');
  });
});
