import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_VAULT } from '../test-support/fake-vault-connection.ts';
import {
  compact,
  createHarness,
  csrfOf,
  EMAIL,
  pageText,
  PASSWORD,
  setUpOperator,
} from '../test-support/identity-app.ts';

import { html } from './pages/template.ts';

import type { Harness } from '../test-support/identity-app.ts';

const CONSOLE_PAGES = ['/account/agents', '/account/activity', '/account/vault', '/account/unlock'];

function sidebarOf(markup: string): string {
  return compact(
    markup.slice(markup.indexOf('<aside class="sidebar">'), markup.indexOf('</aside>')),
  );
}

async function signedInConsole(harness: Harness) {
  const { browser } = await setUpOperator(harness);
  const csrf = csrfOf(await pageText(browser, '/account'));
  return { browser, csrf };
}

describe('the console pages identity serves', () => {
  it('ID-19 ID-22 draws Agents, Activity, Vault and Unlock editing in the console frame under the page policy', async () => {
    const harness = createHarness();
    const { browser } = await signedInConsole(harness);
    for (const path of CONSOLE_PAGES) {
      const response = await browser.get(path);
      const markup = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(markup).toContain('<body class="console">');
      expect(markup).toContain('<aside class="sidebar">');
      expect(markup).not.toContain('<script');
      expect(markup).not.toContain(' style="');
    }
    const sidebar = sidebarOf(await pageText(browser, '/account/agents'));
    expect(sidebar).toContain('<a class="nav-item" href="/account/agents" aria-current="page">');
    expect(sidebar).toContain('href="/account/activity"');
    expect(sidebar).toContain('href="/account/vault"');
    expect(sidebar).toContain(`<span class="operator-email">${EMAIL}</span>`);
    expect(sidebar).toContain('<span class="avatar" aria-hidden="true">AD</span>');
    expect(sidebar).toContain('action="/logout"');
    expect(sidebar).not.toContain('class="cta"');
    const account = sidebarOf(await pageText(browser, '/account'));
    expect(account).toContain('<a href="/account" aria-current="page">Account &amp; security</a>');
  });

  it('ID-22 sends a visitor without a session to sign in and back, and an account with no address to set one', async () => {
    const harness = createHarness();
    const anonymous = harness.browser();
    for (const path of CONSOLE_PAGES) {
      const response = await anonymous.get(path);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`/login?next=${encodeURIComponent(path)}`);
    }
    const { browser } = await setUpOperator(harness);
    harness.database.exec('UPDATE operators SET email = NULL');
    for (const path of CONSOLE_PAGES) {
      const response = await browser.get(path);
      expect(response.headers.get('location')).toBe('/account');
    }
  });

  it('ID-25 shows the vault’s state in the sidebar: not connected, unavailable, ready and when it last synced', async () => {
    const harness = createHarness();
    const { browser } = await signedInConsole(harness);
    const states: [typeof harness.vault.current, string, string][] = [
      [harness.vault.current, 'is-unconfigured', 'Vault not connected'],
      [{ ...ENVIRONMENT_VAULT, ready: false }, 'is-unavailable', 'Vault unavailable'],
      [{ ...ENVIRONMENT_VAULT, lastSyncAt: null }, 'is-ready', 'Not synced since start-up'],
      [ENVIRONMENT_VAULT, 'is-ready', 'Synced 1 h ago'],
    ];
    for (const [status, state, text] of states) {
      harness.vault.current = status;
      const sidebar = sidebarOf(await pageText(browser, '/account/agents'));
      expect(sidebar).toContain(`<a class="vault-status ${state}" href="/account/vault">`);
      expect(sidebar).toContain(text);
    }
    harness.vault.current = { ...ENVIRONMENT_VAULT, ready: false };
    const page = compact(await pageText(browser, '/account/vault'));
    expect(page).toContain('<span class="pill pill-warn">Not ready</span>');
  });

  it('ID-15 counts down the editing window in the top bar and offers the way back into it', async () => {
    const harness = createHarness();
    const { browser, csrf } = await signedInConsole(harness);
    const locked = compact(await pageText(browser, '/account/vault'));
    expect(locked).toContain(
      '<a class="lock-chip" href="/account/unlock?next=%2Faccount%2Fvault">',
    );
    await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
    expect(compact(await pageText(browser, '/account/vault'))).toContain(
      'Editing unlocked · 5 min left',
    );
    harness.advance(150_000);
    expect(compact(await pageText(browser, '/account/vault'))).toContain(
      'Editing unlocked · 3 min left',
    );
    harness.advance(150_001);
    expect(compact(await pageText(browser, '/account/vault'))).toContain('Unlock editing');
  });
});

describe('Unlock editing', () => {
  it('ID-15 confirms the password and returns to the page it was pressed on', async () => {
    const harness = createHarness();
    const { browser, csrf } = await signedInConsole(harness);
    const page = await pageText(browser, '/account/unlock?next=/account/vault');
    expect(page).toContain('<input type="hidden" name="next" value="/account/vault" />');
    const unlocked = await browser.submit('/account/reauthenticate', {
      csrf,
      password: PASSWORD,
      next: '/account/vault',
    });
    expect(unlocked.status).toBe(303);
    expect(unlocked.headers.get('location')).toBe('/account/vault');
    expect(await pageText(browser, '/account/vault')).toContain('action="/account/vault"');
  });

  it('ID-15 ID-18 shows the unlock page again for a wrong password and never leaves the origin', async () => {
    const harness = createHarness();
    const { browser, csrf } = await signedInConsole(harness);
    const wrong = await browser.submit('/account/reauthenticate', {
      csrf,
      password: 'not the password',
      next: '/account/agents',
    });
    const markup = await wrong.text();
    expect(wrong.status).toBe(401);
    expect(markup).toContain('<h1>Unlock editing</h1>');
    expect(markup).toContain('That password was not recognised.');
    expect(markup).toContain('<input type="hidden" name="next" value="/account/agents" />');
    const elsewhere = await pageText(browser, '/account/unlock?next=//evil.example/x');
    expect(elsewhere).toContain('<input type="hidden" name="next" value="/account" />');
    const away = await browser.submit('/account/reauthenticate', {
      csrf,
      password: PASSWORD,
      next: 'https://evil.example/x',
    });
    expect(away.headers.get('location')).toBe('/account?notice=reauthenticated');
  });
});

describe('what other layers add to the console', () => {
  it('ACT-5 draws another layer’s navigation, primary action, Activity badge and sections', async () => {
    const harness = createHarness({
      navigation: () => ({
        items: [
          {
            key: 'computers',
            label: 'Computers',
            href: '/account/actions',
            icon: 'server',
            count: 2,
            children: [{ label: 'SQL Server', href: '/x', count: 2, kind: 'mssql' }],
          },
        ],
        primaryAction: { label: 'Add computer', href: '/account/actions/new' },
        activityBadge: { text: '3', title: '3 unexpected writes this week' },
      }),
      sections: {
        agents: [() => html`<p id="agents-extra">added</p>`],
        activity: [() => Promise.resolve(html`<p id="activity-extra">added</p>`)],
        vault: [() => html`<p id="vault-extra">added</p>`],
      },
    });
    const { browser } = await signedInConsole(harness);
    const agents = await pageText(browser, '/account/agents');
    const sidebar = sidebarOf(agents);
    expect(sidebar).toContain('<a class="cta" href="/account/actions/new">');
    expect(sidebar).toContain('<span class="nav-count">2</span>');
    expect(sidebar).toContain('<span class="kind-dot kind-mssql"></span><span>SQL Server</span>');
    expect(sidebar).toContain('<span class="nav-badge" title="3 unexpected writes this week">');
    expect(sidebar.indexOf('Computers')).toBeLessThan(sidebar.indexOf('Agents'));
    expect(agents).toContain('<p id="agents-extra">added</p>');
    expect(await pageText(browser, '/account/activity')).toContain(
      '<p id="activity-extra">added</p>',
    );
    expect(await pageText(browser, '/account/vault')).toContain('<p id="vault-extra">added</p>');
  });
});
