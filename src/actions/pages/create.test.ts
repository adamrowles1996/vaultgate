import { describe, expect, it } from 'vitest';

import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { csrfOf, pageText, PASSWORD } from '../../test-support/identity-app.ts';

import type { PagesHarness } from '../../test-support/actions-pages.ts';

const FIVE_MINUTES = 5 * 60_000;

/**
A complete `http` target as the form posts it, on the fixture login item.
*/
const VALID = {
  connector: 'http',
  name: 'crm',
  description: 'The CRM API',
  'credential.item_id': 'item-login',
  'destination.base_url': 'https://crm.example.com/api',
  'credential.mode': 'bearer',
  'credential.field': 'password',
  'policy.allowed_methods.GET': 'on',
  'policy.allowed_paths': '/v1/**\r\n\r\n  /health  ',
  'policy.confirm_writes': 'on',
  'policy.timeout_ms': '5000',
};

const HIDDEN_INPUT = /<input type="hidden" name="([^"]+)" value="([^"]*)"/gu;
const CHECKED_BOX = /name="([^"]+)" type="checkbox" checked/gu;
const SELECTED_OPTION = /<select name="([^"]+)"[\s\S]*?<option value="([^"]*)" selected/gu;

/**
 * What a browser would send from the rendered form: its hidden fields, the
 * boxes the page renders as checked and the selected option of each select.
 * A field the form forgets to render is a field the route never receives.
 */
function submittedByBrowser(markup: string): readonly (readonly [string, string])[] {
  const fields: [string, string][] = [];
  for (const [, name = '', value = ''] of markup.matchAll(HIDDEN_INPUT)) {
    fields.push([name, value]);
  }
  for (const [, name = ''] of markup.matchAll(CHECKED_BOX)) {
    fields.push([name, 'on']);
  }
  for (const [, name = '', value = ''] of markup.matchAll(SELECTED_OPTION)) {
    fields.push([name, value]);
  }
  return fields;
}

function operatorId(harness: PagesHarness): string {
  return harness.identity.stores.operators.findAny()?.id ?? '';
}

function actionsAudit(harness: PagesHarness) {
  return harness.actions.audit.map((event) => ({
    action: event.action,
    operatorId: event.operatorId,
    details: event.details,
  }));
}

describe('GET /account/actions/new', () => {
  it('ACT-2 ACT-5 ACT-49 offers the create form with the defaults and ceilings once the password is confirmed', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness, false);
    const before = await browser.get('/account/actions/new?connector=http');
    const beforeMarkup = await before.text();
    expect(beforeMarkup).toContain('<title>Add HTTP API · vaultgate</title>');
    expect(beforeMarkup).toContain(
      'href="/account/unlock?next=%2Faccount%2Factions%2Fnew%3Fconnector%3Dhttp"',
    );
    expect(beforeMarkup).not.toContain('action="/account/actions"');
    const csrf = csrfOf(await pageText(browser, '/account'));
    await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    const after = await browser.get('/account/actions/new?connector=http&item=item-login');
    const markup = await after.text();
    expect(markup).toContain('<form method="post" action="/account/actions" class="target-form">');
    expect(markup).toContain('name="name"');
    expect(markup).toContain('pattern="[a-z0-9][a-z0-9-]{0,62}"');
    expect(markup).toContain('name="policy.confirm_writes" type="checkbox" checked');
    expect(markup).toContain('name="policy.allowed_methods.GET" type="checkbox" checked');
    expect(markup).toContain('name="policy.allowed_methods.HEAD" type="checkbox" checked');
    expect(markup).toContain('name="policy.allowed_methods.POST" type="checkbox"  />');
    expect(markup).toContain('<option value="bearer" selected>bearer</option>');
    expect(markup).toContain(
      '<textarea name="policy.allowed_request_headers" rows="4">accept\ncontent-type\nif-none-match</textarea>',
    );
    expect(markup).toContain('name="policy.timeout_ms"');
    expect(markup).toContain('max="300000"');
    expect(markup).toContain('value="30000"');
    expect(markup).toContain('Default 262 144 (256 KiB), at most 1 048 576 (1 MiB)');
    expect(markup).toContain('a tenant id or a verified domain name');
    expect(markup).toContain('name="credential.refresh_token_field"');
  });

  it('ACT-2 ACT-6 posts what the rendered form carries: a submission of exactly its controls creates the target', async () => {
    const harness = createPagesHarness();
    const { browser } = await signedInOperator(harness);
    const markup = await pageText(browser, '/account/actions/new?connector=http&item=item-login');
    // Every control a browser would send: the hidden fields, the text inputs
    // and selects filled in, the checkboxes the page renders as checked.
    const submitted: Record<string, string> = {
      ...Object.fromEntries(submittedByBrowser(markup)),
      name: 'crm',
      description: 'The CRM API',
      'credential.item_id': 'item-login',
      'destination.base_url': 'https://crm.example.com/api',
      'credential.field': 'password',
      'policy.allowed_paths': '/v1/**',
      address_from: '',
    };
    expect(submitted['connector']).toBe('http');
    const response = await browser.submit('/account/actions', submitted);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account/actions/id-1?notice=created');
    expect(harness.actions.engine.targets.get('id-1')).toMatchObject({
      name: 'crm',
      connector: 'http',
      destination: { base_url: 'https://crm.example.com/api' },
    });
  });
});

describe('POST /account/actions', () => {
  it('ACT-2 ACT-3 ACT-4 ACT-6 ACT-7 ACT-49 creates a target from the form, resolving the destination and checking the vault item, and records the event', async () => {
    const harness = createPagesHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', { csrf, ...VALID });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account/actions/id-1?notice=created');
    expect(harness.actions.engine.targets.get('id-1')).toMatchObject({
      name: 'crm',
      description: 'The CRM API',
      connector: 'http',
      destination: { base_url: 'https://crm.example.com/api' },
      internal: false,
      credential: { item_id: 'item-login', mapping: { mode: 'bearer', field: 'password' } },
      policy: {
        allowed_methods: ['GET'],
        allowed_paths: ['/v1/**', '/health'],
        confirm_writes: true,
        follow_redirects: false,
        allow_query_credentials: false,
        timeout_ms: 5000,
      },
      enabled: true,
      revision: 1,
      state: 'valid',
      updatedBy: operatorId(harness),
    });
    expect(harness.actions.lookups).toStrictEqual(['crm.example.com']);
    expect(actionsAudit(harness)).toStrictEqual([
      {
        action: 'target_created',
        operatorId: operatorId(harness),
        details: { target: 'crm', connector: 'http' },
      },
    ]);
    const page = await browser.get('/account/actions/id-1?notice=created');
    const markup = await page.text();
    expect(markup).toContain('<p class="notice">Connection created.</p>');
    expect(markup).toContain('Example Login');
    const edit = await pageText(browser, '/account/actions/id-1/edit');
    expect(edit).toContain(
      '<textarea name="policy.allowed_paths" rows="4">/v1/**\n/health</textarea>',
    );
  });

  it('ACT-6 re-renders the form with every problem and the submitted values for each class of rejected input', async () => {
    const harness = createPagesHarness({
      addresses: { 'private.example.com': ['10.0.0.5'], 'home.example.com': ['127.0.0.1'] },
    });
    const { browser, csrf } = await signedInOperator(harness);
    // A problem that names a control is shown against it; one that names
    // none (the destination as a whole, the credential mapping) is listed.
    const cases: readonly [Record<string, string>, string][] = [
      [
        { name: 'Bad Name' },
        '<p class="field-error">must be 1 to 63 lower-case letters, digits or hyphens',
      ],
      [
        { 'destination.base_url': 'ftp://crm.example.com' },
        '<p class="field-error">must be an https:// (or, on an internal target, http://) URL</p>',
      ],
      [{ 'destination.base_url': 'https://private.example.com' }, '<li>destination: '],
      [
        { 'destination.base_url': 'https://home.example.com', internal: 'on' },
        'which is refused always',
      ],
      [{ 'credential.item_id': 'item-nope' }, 'field-error">no such item in the vault</p>'],
      [
        { 'credential.field': 'custom.nope' },
        '<li>credential.mapping: the item has no &quot;custom.nope&quot; field</li>',
      ],
      [
        { 'policy.allowed_paths': '/../up' },
        '(&quot;/../up&quot; must start with / and stay under base_url)</p>',
      ],
      [
        { 'policy.allowed_paths': '/a/./b' },
        'is not in normalised form; write it as &quot;/a/b&quot;)</p>',
      ],
      [
        { 'credential.mode': 'basic', 'credential.field': '' },
        '<li>credential.mapping.field: Invalid input: expected string, received undefined</li>',
      ],
    ];
    for (const [fields, problem] of cases) {
      const response = await browser.submit('/account/actions', { csrf, ...VALID, ...fields });
      const markup = await response.text();
      expect(response.status).toBe(400);
      expect(markup).toContain(
        'The connection was not saved; fix the problems shown against each field and try again.',
      );
      expect(markup).toContain(problem);
      expect(markup).toContain(
        '<form method="post" action="/account/actions" class="target-form">',
      );
    }
    const last = await browser.submit('/account/actions', {
      csrf,
      ...VALID,
      name: 'Bad Name',
      'destination.base_url': 'nope',
      'credential.mode': 'header',
      'credential.name': 'X-Api-Key',
      'policy.allowed_methods.POST': 'on',
      internal: 'on',
    });
    const markup = await last.text();
    expect(markup).toContain('<p class="field-error">must be 1 to 63 lower-case letters');
    expect(markup).toContain('value="Bad Name"');
    expect(markup).toContain('value="nope"');
    expect(markup).toContain('<option value="header" selected>header</option>');
    expect(markup).toContain('name="credential.name" value="X-Api-Key"');
    expect(markup).toContain('name="policy.allowed_methods.POST" type="checkbox" checked');
    expect(markup).toContain('name="internal" type="checkbox" checked');
    const empty = await browser.submit('/account/actions', { csrf, connector: 'http' });
    const emptyMarkup = await empty.text();
    expect(empty.status).toBe(400);
    expect(emptyMarkup).toContain('<p class="field-error">must be 1 to 63 lower-case letters');
    expect(emptyMarkup).toContain('field-error">Too small: expected string to have &gt;=1');
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
    expect(actionsAudit(harness)).toStrictEqual([]);
  });

  it('ACT-2 answers 404 for a connector this build cannot create', async () => {
    const harness = createPagesHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      ...VALID,
      connector: 'browser',
    });
    expect(response.status).toBe(404);
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
  });

  it('ID-15 refuses to create without a password confirmation in the last five minutes', async () => {
    const harness = createPagesHarness();
    const { browser, csrf } = await signedInOperator(harness, false);
    const denied = await browser.submit('/account/actions', { csrf, ...VALID });
    expect(denied.status).toBe(403);
    await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    harness.identity.advance(FIVE_MINUTES + 1);
    const stale = await browser.submit('/account/actions', { csrf, ...VALID });
    expect(stale.status).toBe(403);
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
    expect(
      harness.identity.audits
        .filter((event) => event.action === 'request.denied')
        .map((event) => event.details),
    ).toStrictEqual([
      { reason: 're-authentication required', path: '/account/actions' },
      { reason: 're-authentication required', path: '/account/actions' },
    ]);
  });

  it('ID-18 refuses a cross-site submission, a stale synchroniser token and a request without a session', async () => {
    const harness = createPagesHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const crossSite = await browser.submit(
      '/account/actions',
      { csrf, ...VALID },
      { origin: false },
    );
    expect(crossSite.status).toBe(403);
    const staleToken = await browser.submit('/account/actions', { ...VALID, csrf: 'stale' });
    expect(staleToken.status).toBe(403);
    const anonymous = await harness.browser().submit('/account/actions', { csrf, ...VALID });
    expect(anonymous.status).toBe(403);
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
    expect(
      harness.identity.audits
        .filter((event) => event.action === 'request.denied')
        .map((event) => event.details?.['reason']),
    ).toStrictEqual(['cross-origin request', 'missing or stale synchroniser token', 'no session']);
  });
});
