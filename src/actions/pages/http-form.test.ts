// cspell:ignore PVEAPI
import { describe, expect, it } from 'vitest';

import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { pageText } from '../../test-support/identity-app.ts';
import { TEST_CERTIFICATE_PEM } from '../../test-support/test-certificate.ts';
import { validateTarget } from '../targets-schemas.ts';

import { formFor } from './forms.ts';

import type { PagesHarness } from '../../test-support/actions-pages.ts';

const DIGEST = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900';
const PVE = 'https://pve.example.internal:8006/api2/json';

/**
An `http` connection to a cluster API as the form posts it, on the fixture login item.
*/
const SUBMITTED = {
  connector: 'http',
  name: 'pve',
  description: 'The cluster API',
  internal: 'on',
  'credential.item_id': 'item-login',
  'destination.base_url': PVE,
  'credential.mode': 'header',
  'credential.field': 'password',
  'credential.name': 'Authorization',
  'credential.prefix': 'PVEAPIToken=vaultgate@pve!agent=',
  'policy.allowed_methods.GET': 'on',
  'policy.allowed_paths': '/**',
};

function clusterHarness(): PagesHarness {
  return createPagesHarness({ addresses: { 'pve.example.internal': ['10.0.0.8'] } });
}

/**
The destination as the connector reads it: parsed, and so normalised, from the row as the operator wrote it.
*/
function parsedDestination(harness: PagesHarness, id: string): unknown {
  const stored = harness.actions.engine.targets.get(id);
  const validated = stored === undefined ? undefined : validateTarget(stored);
  return validated?.state === 'valid' ? validated.documents.destination : undefined;
}

function destinationFields(): readonly string[] {
  const form = formFor('http', { allowAnyCommand: false });
  return (form?.fields ?? [])
    .filter((field) => field.document === 'destination')
    .map((field) => field.name);
}

describe('the http form’s private trust', () => {
  it('ACT-121 ACT-122 offers the pin and the authority after the base URL, the authority in the PEM box sql uses', async () => {
    expect(destinationFields()).toStrictEqual(['base_url', 'certificate_sha256', 'ca_pem']);
    const { browser } = await signedInOperator(createPagesHarness());
    const form = await pageText(browser, '/account/actions/new?connector=http&item=item-login');
    expect(form).toContain(
      '<input name="destination.certificate_sha256" value="" autocomplete="off"',
    );
    // A single-line box would drop a pasted PEM's line breaks.
    expect(form).toContain('<textarea name="destination.ca_pem" rows="8" spellcheck="false"');
    expect(form).toContain('A renewed certificate needs a new fingerprint.');
    expect(form).toContain(
      'the base URL’s host must be a name or address that certificate carries',
    );
  });

  it('ACT-121 ACT-122 ACT-6 saves a pin and an authority as written, and reads and shows the pin again in its one form', async () => {
    const harness = clusterHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const colons = DIGEST.toUpperCase().replaceAll(/(.{2})(?=.)/gu, '$1:');
    const pinned = await browser.submit('/account/actions', {
      csrf,
      ...SUBMITTED,
      'destination.certificate_sha256': colons,
    });
    expect(pinned.headers.get('location')).toBe('/account/actions/id-1?notice=created');
    const authority = await browser.submit('/account/actions', {
      csrf,
      ...SUBMITTED,
      name: 'pve-ca',
      'destination.ca_pem': `\n${TEST_CERTIFICATE_PEM}\n`,
    });
    expect(authority.headers.get('location')).toBe('/account/actions/id-2?notice=created');
    const { targets } = harness.actions.engine;
    expect(targets.get('id-1')?.destination).toStrictEqual({
      base_url: PVE,
      certificate_sha256: colons,
    });
    expect(parsedDestination(harness, 'id-1')).toStrictEqual({
      base_url: PVE,
      certificate_sha256: DIGEST,
    });
    expect(parsedDestination(harness, 'id-2')).toStrictEqual({
      base_url: PVE,
      ca_pem: TEST_CERTIFICATE_PEM,
    });
    expect(targets.get('id-2')?.credential.mapping).toMatchObject({ name: 'Authorization' });
    const pinnedEdit = await pageText(browser, '/account/actions/id-1/edit');
    expect(pinnedEdit).toContain(`name="destination.certificate_sha256" value="${DIGEST}"`);
    const authorityEdit = await pageText(browser, '/account/actions/id-2/edit');
    expect(authorityEdit).toContain(`${TEST_CERTIFICATE_PEM}</textarea>`);
  });

  it('ACT-121 ACT-122 ACT-6 shows every trust problem of a rejected save against the field it names', async () => {
    const harness = clusterHarness();
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      ...SUBMITTED,
      'destination.base_url': 'http://pve.example.internal:8006/api2/json',
      'destination.certificate_sha256': DIGEST,
      'destination.ca_pem': TEST_CERTIFICATE_PEM.replaceAll('\n', ''),
    });
    expect(response.status).toBe(400);
    const markup = await response.text();
    for (const problem of [
      'give a certificate pin or a certificate authority, not both',
      'a certificate pin needs an https:// base_url',
      'a certificate authority needs an https:// base_url',
      'is not a PEM certificate; paste it with its line breaks',
    ]) {
      expect(markup).toContain(`<p class="field-error">${problem}`);
    }
    expect(harness.actions.engine.targets.get('id-1')).toBeUndefined();
  });
});
