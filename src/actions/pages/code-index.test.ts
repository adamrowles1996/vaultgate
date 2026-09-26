import { describe, expect, it, vi } from 'vitest';

import { createHttpTarget } from '../../test-support/actions-fixtures.ts';
import { signedInOperator } from '../../test-support/actions-pages.ts';
import {
  CODE_FORM,
  createCodePages,
  EMPTY_STATUS,
  PRIVATE_SHA,
  stubControl,
} from '../../test-support/code-pages.ts';
import { compact, pageText } from '../../test-support/identity-app.ts';

import type { CodeIndexStatus } from '../connectors/code/control.ts';

const SIX_MINUTES = 6 * 60_000;

function indexCardOf(markup: string): string {
  const start = markup.indexOf('<section class="card" id="index">');
  return start === -1 ? '' : markup.slice(start, markup.indexOf('</section>', start));
}

async function codeTarget(options: Parameters<typeof createCodePages>[0] = {}) {
  const pages = createCodePages(options);
  const operator = await signedInOperator(pages.harness);
  const created = await operator.browser.submit('/account/actions', {
    ...CODE_FORM,
    csrf: operator.csrf,
  });
  expect(created.status).toBe(303);
  return { ...pages, ...operator };
}

describe('the Index card of a Semble connection (ACT-115)', () => {
  it('ACT-108 ACT-115 builds on save and shows the snapshot, its indexes, its skips, the ref’s resolution and the last build', async () => {
    const { browser, sidecar, harness } = await codeTarget();
    await vi.waitFor(() => {
      expect(sidecar.snapshots.size).toBe(1);
    });
    await vi.waitFor(() => {
      expect(harness.actions.audit.map((event) => event.action)).toContain('code_index_built');
    });
    const card = compact(indexCardOf(await pageText(browser, '/account/actions/id-1')));
    expect(card).toContain('<h2>Index</h2>');
    expect(card).toContain(
      `<span class="mono" title="${PRIVATE_SHA}">${PRIVATE_SHA.slice(0, 12)}</span>`,
    );
    expect(card).toContain('<span class="mono">main</span>');
    expect(card).toContain('Answers calls');
    expect(card).toContain('<span class="mono">code+docs+config</span>');
    expect(card).toContain('3 files · 7 chunks');
    expect(card).toContain('2 excluded · 0 too large · 1 links · 0 special');
    expect(card).toContain('<span class="pill pill-ok">Built</span>');
    expect(card).toContain('on save');
    expect(card).toContain('<dt>Building</dt><dd>No</dd>');
    expect(card).toContain('<dt>Last failure</dt><dd>None since vaultgate started</dd>');
    expect(card).toContain('<form method="post" action="/account/actions/id-1/rebuild">');
  });

  it('ACT-108 ID-18 rebuilds behind the session and CSRF token but not ID-15, without waiting for the build, and says so', async () => {
    const { browser, csrf, sidecar, harness } = await codeTarget();
    await vi.waitFor(() => {
      expect(sidecar.builds).toHaveLength(1);
    });
    harness.identity.advance(SIX_MINUTES);
    const page = compact(await pageText(browser, '/account/actions/id-1'));
    expect(page).toContain('Unlock editing');
    expect(page).toContain('<form method="post" action="/account/actions/id-1/rebuild">');
    const release = sidecar.hold();
    const response = await browser.submit('/account/actions/id-1/rebuild', { csrf });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account/actions/id-1?notice=rebuilding');
    const building = compact(await pageText(browser, '/account/actions/id-1?notice=rebuilding'));
    expect(building).toContain(
      '<p class="notice">Rebuilding the index; this page shows it when it is done.</p>',
    );
    release();
    await vi.waitFor(() => {
      const built = harness.actions.audit.filter((event) => event.action === 'code_index_built');
      expect(built.map((event) => event.details?.['trigger'])).toStrictEqual(['save', 'operator']);
    });
    const card = compact(indexCardOf(await pageText(browser, '/account/actions/id-1')));
    expect(card).toContain('on operator');
  });

  it('ID-18 refuses a rebuild without the synchroniser token, and answers 404 for no such connection', async () => {
    const { browser, csrf } = await codeTarget();
    const unsigned = await browser.submit('/account/actions/id-1/rebuild', {});
    expect(unsigned.status).toBe(403);
    const missing = await browser.submit('/account/actions/nope/rebuild', { csrf });
    expect(missing.status).toBe(404);
  });

  it('ACT-113 ACT-115 still draws the page when the sidecar does not answer', async () => {
    const { browser, sidecar } = await codeTarget();
    await vi.waitFor(() => {
      expect(sidecar.builds).toHaveLength(1);
    });
    sidecar.unreachable(true);
    const card = compact(indexCardOf(await pageText(browser, '/account/actions/id-1')));
    expect(card).toContain('The code sidecar is not answering');
    expect(card).toContain('No snapshot yet');
  });

  it('ACT-73 ACT-115 draws a Semble connection whose connector is off, and refuses to rebuild it', async () => {
    const { browser, csrf, harness } = await codeTarget({ connector: false });
    const card = compact(indexCardOf(await pageText(browser, '/account/actions/id-1')));
    expect(card).toContain('The code connector is off on this deployment');
    expect(card).not.toContain('/rebuild');
    const refused = await browser.submit('/account/actions/id-1/rebuild', { csrf });
    expect(refused.status).toBe(400);
    expect(compact(await refused.text())).toContain('This connection has no index to rebuild');
    const http = await createHttpTarget(harness.actions, { name: 'api' });
    const other = compact(await pageText(browser, `/account/actions/${http.id}`));
    expect(other).not.toContain('id="index"');
    const notCode = await browser.submit(`/account/actions/${http.id}/rebuild`, { csrf });
    expect(notCode.status).toBe(400);
  });
});

describe('what the Index card says of each state (ACT-115)', () => {
  const FAILING: CodeIndexStatus = {
    reachable: true,
    building: true,
    snapshots: [
      {
        key: 'id-1/k',
        owner: 'id-1',
        commit: 'c'.repeat(40),
        created_at: 0,
        last_used_at: 0,
        files: 0,
        bytes: 0,
        skipped: { links: 0, special: 2, excluded: 5, large: 1 },
        storage_bytes: 0,
        variants: {},
        ref: undefined,
        trigger: undefined,
        current: false,
      },
    ],
    resolution: { at: 0, failure: 'ref_not_found' },
    lastBuild: {
      at: 0,
      commit: 'd'.repeat(40),
      trigger: 'call',
      durationMs: 5,
      reason: 'archive_too_large',
    },
    lastFailure: { at: 0, trigger: 'operator', durationMs: 0, reason: 'credential_unavailable' },
  };

  it('ACT-112 ACT-115 shows a running build, a failed resolution, the failure’s reason and trigger, and an old snapshot', async () => {
    const control = stubControl(FAILING);
    const { browser } = await codeTarget({ codeControl: control });
    const card = compact(indexCardOf(await pageText(browser, '/account/actions/id-1')));
    expect(card).toContain('A build is running');
    expect(card).toContain('<span class="bad">ref_not_found</span>');
    expect(card).toContain(
      '<span class="pill pill-bad">Failed</span> <span class="mono">archive_too_large</span>',
    );
    expect(card).toContain('on call');
    expect(card).toContain('not known since a restart');
    expect(card).toContain(
      '<span class="pill pill-bad">Failed</span> <span class="mono">credential_unavailable</span> · did not start · on operator',
    );
    expect(card).toContain('Not the current one');
    expect(card).toContain('None yet');
    expect(card).toContain('5 excluded · 1 too large · 0 links · 2 special');
  });

  it('ACT-115 says when nothing has been resolved or built since vaultgate started', async () => {
    const { browser } = await codeTarget({ codeControl: stubControl(EMPTY_STATUS) });
    const card = compact(indexCardOf(await pageText(browser, '/account/actions/id-1')));
    expect(card).toContain('<dt>Last build</dt><dd>None since vaultgate started</dd>');
    expect(card).toContain('<dt>Configured ref</dt><dd>Not resolved since vaultgate started</dd>');
  });

  it('ACT-108 hands the rebuild to the connector as an operator reset, and a build that throws never fails the request', async () => {
    const control = stubControl(EMPTY_STATUS, true);
    const { browser, csrf } = await codeTarget({ codeControl: control });
    const response = await browser.submit('/account/actions/id-1/rebuild', { csrf });
    expect(response.status).toBe(303);
    expect(control.refreshed).toStrictEqual([
      { targetId: 'id-1', trigger: 'operator', isReset: true },
    ]);
  });
});
