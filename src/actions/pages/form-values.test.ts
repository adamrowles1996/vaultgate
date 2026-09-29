import { describe, expect, it } from 'vitest';

import { defaultValues, documentsFromForm, valuesFromDocuments } from './form-values.ts';
import { editableConnectors, formFor } from './forms.ts';

import type { ConnectorForm } from './descriptors.ts';

const HTTP: ConnectorForm = formFor('http', { allowAnyCommand: false }) ?? {
  kind: 'http',
  fields: [],
};

describe('documentsFromForm', () => {
  it('ACT-6 reads each control kind into its document, trimming text, splitting lines and leaving empties out', () => {
    const documents = documentsFromForm(
      HTTP,
      new Map([
        ['destination.base_url', '  https://api.example.com  '],
        ['credential.mode', 'basic'],
        ['credential.field', 'password'],
        ['credential.username_from', ''],
        ['policy.allowed_methods.GET', 'on'],
        ['policy.allowed_methods.DELETE', 'on'],
        ['policy.allowed_paths', ' /a/** \r\n\n/b\n'],
        ['policy.allowed_request_headers', '\n  \n'],
        ['policy.max_body_bytes', ' 1024 '],
        ['policy.timeout_ms', ''],
        ['policy.follow_redirects', 'on'],
        ['policy.rate_limit_per_minute', 'ten'],
      ]),
    );
    expect(documents).toStrictEqual({
      destination: { base_url: 'https://api.example.com' },
      credential: { mode: 'basic', field: 'password' },
      policy: {
        allowed_methods: ['GET', 'DELETE'],
        allowed_paths: ['/a/**', '/b'],
        max_body_bytes: 1024,
        follow_redirects: true,
        allow_query_credentials: false,
        rate_limit_per_minute: NaN,
      },
    });
  });

  it('ACT-6 leaves out the fields of the modes not chosen, and every mode field when no mode was sent', () => {
    const graph = documentsFromForm(
      HTTP,
      new Map([
        ['credential.mode', 'graph'],
        ['credential.field', 'password'],
        ['credential.name', 'X-Key'],
        ['credential.tenant_id', 'tenant'],
        ['credential.grant', 'refresh_token'],
      ]),
    );
    expect(graph.credential).toStrictEqual({
      mode: 'graph',
      tenant_id: 'tenant',
      grant: 'refresh_token',
    });
    const none = documentsFromForm(HTTP, new Map([['credential.field', 'password']]));
    expect(none.credential).toStrictEqual({});
  });
});

describe('valuesFromDocuments', () => {
  it('ACT-5 shows stored documents in the form and renders a field of the wrong shape empty', () => {
    const values = valuesFromDocuments(HTTP, {
      destination: { base_url: 'https://api.example.com' },
      credential: { mode: 'header', name: 'X-Key', prefix: 7, field: ['not', 'text'] },
      policy: {
        allowed_methods: ['GET', 'PUT', 42],
        allowed_paths: 'not a list',
        response_headers: ['location'],
        timeout_ms: 5000,
        follow_redirects: 'yes',
      },
    });
    expect(Object.fromEntries(values)).toStrictEqual({
      'destination.base_url': 'https://api.example.com',
      'destination.certificate_sha256': '',
      'destination.ca_pem': '',
      'credential.mode': 'header',
      'credential.name': 'X-Key',
      'credential.prefix': '7',
      'credential.field': '',
      'credential.username_from': '',
      'credential.tenant_id': '',
      'credential.client_id': '',
      'credential.grant': '',
      'credential.scope': '',
      'credential.secret_field': '',
      'credential.refresh_token_field': '',
      'policy.allowed_methods.GET': 'on',
      'policy.allowed_methods.PUT': 'on',
      'policy.allowed_paths': '',
      'policy.allowed_request_headers': '',
      'policy.response_headers': 'location',
      'policy.max_body_bytes': '',
      'policy.follow_redirects': '',
      'policy.allow_query_credentials': '',
      'policy.timeout_ms': '5000',
      'policy.max_output_bytes': '',
      'policy.rate_limit_per_minute': '',
    });
    const missing = valuesFromDocuments(HTTP, {
      destination: 'nope',
      credential: null,
      policy: [],
    });
    expect(missing.size).toBe(0);
  });

  it('ACT-5 starts a new target from every fallback', () => {
    const values = defaultValues(HTTP);
    expect(values.get('policy.allowed_methods.GET')).toBe('on');
    expect(values.get('policy.allowed_methods.HEAD')).toBe('on');
    expect(values.has('policy.allowed_methods.POST')).toBe(false);
    expect(values.get('policy.timeout_ms')).toBe('30000');
    expect(values.get('policy.allowed_paths')).toBe('');
    expect(values.get('credential.mode')).toBe('bearer');
    expect(values.get('policy.follow_redirects')).toBe('');
    expect(values.get('destination.base_url')).toBe('');
  });
});

describe('a new target’s defaults', () => {
  it('ACT-40 draws no write confirmation on any connector’s form: approval belongs to the agent’s client', () => {
    for (const kind of editableConnectors()) {
      const form = formFor(kind, { allowAnyCommand: true });
      expect(form).toBeDefined();
      const names = (form?.fields ?? []).map((field) => `${field.document}.${field.name}`);
      expect(names).not.toContain('policy.confirm_writes');
      expect(defaultValues(form ?? HTTP).has('policy.confirm_writes')).toBe(false);
    }
  });
});
