import { describe, expect, it } from 'vitest';

import { flattenHtml } from '../test-support/oauth-http.ts';

import { renderConsentPage, renderErrorPage, scopeFieldName } from './consent-page.ts';
import { OAuthError } from './errors.ts';

const VIEW = {
  requestId: 'req-1',
  csrfToken: 'csrf-1',
  clientName: 'Agent <One>',
  redirectHost: 'agent.example.com:8443',
  mode: 'cimd' as const,
  loopbackOnly: false,
  scopes: ['vault:read', 'vault:reveal', 'vault:generate'] as const,
};

describe('renderConsentPage', () => {
  it('OAUTH-13 shows the escaped client name, the full redirect host and the registration mechanism', () => {
    const html = flattenHtml(renderConsentPage(VIEW));
    expect(html).toContain('<strong>Agent &lt;One&gt;</strong>');
    expect(html).toContain('<dt>Will redirect to</dt><dd><code>agent.example.com:8443</code></dd>');
    expect(html).toContain('identified by its client metadata document');
    expect(html).not.toContain('class="warning"');
    expect(html).not.toContain('<script');
  });

  it('OAUTH-13 / T7 warns prominently when every redirect is loopback', () => {
    const html = flattenHtml(
      renderConsentPage({
        ...VIEW,
        loopbackOnly: true,
        redirectHost: '127.0.0.1:53211',
        mode: 'dcr',
      }),
    );
    expect(html).toContain('<p class="warning"><strong>Warning:</strong>this client redirects');
    expect(html).toContain('loopback address (<code>127.0.0.1:53211</code>)');
    expect(html).toContain('registered dynamically; nobody has vetted this client');
  });

  it('OAUTH-36 lists each scope with its explanation and marks the risky ones', () => {
    const html = flattenHtml(renderConsentPage(VIEW));
    expect(html).toContain(
      '<code>vault:reveal</code><strong class="risk">Sensitive</strong>— Reveal',
    );
    expect(html).toContain('<code>vault:generate</code>— Generate passwords and passphrases.');
    expect(html).not.toContain('vault:write');
  });

  it('ACT-13 groups the actions scopes under the plain-language warning and adds the browser sentence, verbatim', () => {
    const html = flattenHtml(
      renderConsentPage({ ...VIEW, scopes: ['vault:read', 'actions:http', 'actions:browser'] }),
    );
    expect(html).toContain(
      '<p class="actions-note">These let the agent act on other systems with your credentials. ' +
        'It never sees the credentials, but it can do what the targets allow.</p>',
    );
    expect(html).toContain(
      '<code>actions:http</code><strong class="risk">Sensitive</strong>— Send HTTP requests to ' +
        'web APIs the operator has configured, signed with credentials from the vault.</label>',
    );
    expect(html).toContain(
      '<code>actions:browser</code><strong class="risk">Sensitive</strong>— Sign in to websites ' +
        'the operator has configured and act there as you, within the pages the operator allows. ' +
        'A signed-in browser can do anything you can do on that site.</label>',
    );
    expect(html.indexOf('actions-note')).toBeGreaterThan(html.indexOf('vault:read'));
    expect(flattenHtml(renderConsentPage(VIEW))).not.toContain('actions-note');
  });

  it('OAUTH-16 / OAUTH-18 makes vault:read untickable and the others ticked, in a CSRF-guarded form', () => {
    const html = flattenHtml(renderConsentPage({ ...VIEW, mode: 'preregistered' }));
    expect(html).toContain(
      `<input type="checkbox" checked disabled /><input type="hidden" name="${scopeFieldName('vault:read')}" value="on" /><code>vault:read</code>`,
    );
    expect(html).toContain(
      `<input type="checkbox" name="${scopeFieldName('vault:reveal')}" value="on" checked /><code>vault:reveal</code>`,
    );
    expect(html).toContain('<form method="post" action="/oauth/authorize">');
    expect(html).toContain('<input type="hidden" name="request_id" value="req-1" />');
    expect(html).toContain('<input type="hidden" name="csrf" value="csrf-1" />');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain('pre-registered by the operator');
  });
});

describe('renderErrorPage', () => {
  it('OAUTH-14 names the error code and description without any redirect', () => {
    const html = renderErrorPage(
      new OAuthError('invalid_request', 'client_id & redirect_uri are required'),
    );
    expect(html).toContain('<code>invalid_request</code>');
    expect(html).toContain('client_id &amp; redirect_uri are required');
    expect(html).not.toContain('http-equiv');
  });
});
