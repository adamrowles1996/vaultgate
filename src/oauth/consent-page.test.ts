import { describe, expect, it } from 'vitest';

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
    const html = renderConsentPage(VIEW);
    expect(html).toContain('<strong>Agent &lt;One&gt;</strong>');
    expect(html).toContain('<dt>Will redirect to</dt><dd><code>agent.example.com:8443</code></dd>');
    expect(html).toContain('identified by its client metadata document');
    expect(html).not.toContain('class="warning"');
    expect(html).not.toContain('<script');
  });

  it('OAUTH-13 / T7 warns prominently when every redirect is loopback', () => {
    const html = renderConsentPage({
      ...VIEW,
      loopbackOnly: true,
      redirectHost: '127.0.0.1:53211',
      mode: 'dcr',
    });
    expect(html).toContain('<p class="warning"><strong>Warning:</strong>');
    expect(html).toContain('loopback address (<code>127.0.0.1:53211</code>)');
    expect(html).toContain('registered dynamically; nobody has vetted this client');
  });

  it('OAUTH-36 lists each scope with its explanation and marks the risky ones', () => {
    const html = renderConsentPage(VIEW);
    expect(html).toContain('<code>vault:reveal</code> <strong class="risk">Sensitive</strong>');
    expect(html).toContain('<code>vault:generate</code> — Generate passwords and passphrases.');
    expect(html).not.toContain('vault:write');
  });

  it('OAUTH-16 / OAUTH-18 makes vault:read untickable and the others ticked checkboxes in a CSRF-guarded form', () => {
    const html = renderConsentPage({ ...VIEW, mode: 'preregistered' });
    expect(html).toContain(
      `<input type="checkbox" checked disabled><input type="hidden" name="${scopeFieldName('vault:read')}" value="on">`,
    );
    expect(html).toContain(
      `<input type="checkbox" name="${scopeFieldName('vault:reveal')}" value="on" checked>`,
    );
    expect(html).toContain('<form method="post" action="/oauth/authorize">');
    expect(html).toContain('<input type="hidden" name="request_id" value="req-1">');
    expect(html).toContain('<input type="hidden" name="csrf_token" value="csrf-1">');
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
