/**
 * The `http` connector's form (spec §14.2, §14.3): one descriptor per field
 * of its three documents, in the order the operator reads them, including
 * the `graph` adapter's (ACT-81), whose exchange vaultgate performs itself.
 */
import { HTTP_METHODS } from '../connectors/http/schemas.ts';

import type { FieldDescriptor } from './descriptors.ts';

const KIB = 1024;
const MIB = KIB * KIB;

const MODES = ['bearer', 'basic', 'header', 'query', 'graph'] as const;
const FIELD_MODES = ['bearer', 'basic', 'header', 'query'] as const;
const NAMED_MODES = ['header', 'query'] as const;
const GRAPH = ['graph'] as const;

const SELECTOR_HELP =
  'A vault field: password, totp, notes, custom.<name> for a hidden custom field, ' +
  'card.number, card.code, identity.<field> or sshKey.privateKey.';

const destination: readonly FieldDescriptor[] = [
  {
    document: 'destination',
    name: 'base_url',
    label: 'Base URL',
    kind: 'text',
    required: true,
    help:
      'An https:// origin with an optional path prefix, no query or fragment; http:// only on an ' +
      'internal target. Every request path is appended to it and must stay under it.',
  },
];

const credential: readonly FieldDescriptor[] = [
  {
    document: 'credential',
    name: 'mode',
    label: 'Injection mode',
    kind: 'select',
    options: MODES.map((mode) => ({ value: mode, label: mode })),
    fallback: 'bearer',
    help:
      'bearer: Authorization: Bearer <value>; basic: Authorization: Basic base64(username:value); ' +
      'header: <name>: <prefix><value>; query: <name>=<value> in the query string; graph: a ' +
      'Microsoft Graph token obtained server-side.',
  },
  {
    document: 'credential',
    name: 'field',
    label: 'Secret field',
    kind: 'text',
    when: { field: 'mode', values: FIELD_MODES },
    help: `${SELECTOR_HELP} Used by the bearer, basic, header and query modes.`,
  },
  {
    document: 'credential',
    name: 'username_from',
    label: 'Username field (basic)',
    kind: 'text',
    when: { field: 'mode', values: ['basic'] },
    help: 'login.username unless another field holds it. Used by the basic mode.',
  },
  {
    document: 'credential',
    name: 'name',
    label: 'Header or query parameter name',
    kind: 'text',
    when: { field: 'mode', values: NAMED_MODES },
    help: 'Used by the header and query modes.',
  },
  {
    document: 'credential',
    name: 'prefix',
    label: 'Value prefix',
    kind: 'text',
    when: { field: 'mode', values: NAMED_MODES },
    help: 'Optional, written before the value (for example "Token " with its space).',
  },
  {
    document: 'credential',
    name: 'tenant_id',
    label: 'Graph tenant id',
    kind: 'text',
    when: { field: 'mode', values: GRAPH },
    help:
      'The directory the application belongs to: a tenant id or a verified domain name. ' +
      'The base URL must be https://graph.microsoft.com.',
  },
  {
    document: 'credential',
    name: 'client_id',
    label: 'Graph application (client) id',
    kind: 'text',
    when: { field: 'mode', values: GRAPH },
  },
  {
    document: 'credential',
    name: 'grant',
    label: 'Graph grant',
    kind: 'select',
    options: [
      { value: 'client_credentials', label: 'client_credentials' },
      { value: 'refresh_token', label: 'refresh_token' },
    ],
    fallback: 'client_credentials',
    when: { field: 'mode', values: GRAPH },
  },
  {
    document: 'credential',
    name: 'scope',
    label: 'Graph scope',
    kind: 'text',
    when: { field: 'mode', values: GRAPH },
    help: 'Default https://graph.microsoft.com/.default.',
  },
  {
    document: 'credential',
    name: 'secret_field',
    label: 'Graph client secret field',
    kind: 'text',
    when: { field: 'mode', values: GRAPH },
    help: SELECTOR_HELP,
  },
  {
    document: 'credential',
    name: 'refresh_token_field',
    label: 'Graph refresh token field',
    kind: 'text',
    when: { field: 'mode', values: GRAPH },
    help: 'Required for the refresh_token grant; a hidden custom field is the expected home.',
  },
];

const policy: readonly FieldDescriptor[] = [
  {
    document: 'policy',
    name: 'allowed_methods',
    label: 'Allowed methods',
    kind: 'set',
    options: HTTP_METHODS,
    fallback: ['GET', 'HEAD'],
    help: 'Anything but GET, HEAD and OPTIONS is a non-read call.',
  },
  {
    document: 'policy',
    name: 'allowed_paths',
    label: 'Allowed paths',
    kind: 'lines',
    fallback: [],
    help:
      'One pattern per line, matched against the path and query relative to the base URL: * ' +
      'matches within one segment, ** across segments; /** allows the whole API.',
  },
  {
    document: 'policy',
    name: 'allowed_request_headers',
    label: 'Allowed request headers',
    kind: 'lines',
    fallback: ['accept', 'content-type', 'if-none-match'],
    help:
      'One name per line. Authorization, Cookie, Host, Content-Length, User-Agent, ' +
      'Transfer-Encoding, Proxy-* and the header the credential occupies can never be set by an ' +
      'agent, whatever this list says.',
  },
  {
    document: 'policy',
    name: 'response_headers',
    label: 'Returned response headers',
    kind: 'lines',
    fallback: ['content-type', 'content-length', 'location', 'retry-after'],
    help: 'One name per line; every other response header is dropped.',
  },
  {
    document: 'policy',
    name: 'max_body_bytes',
    label: 'Maximum request body (bytes)',
    kind: 'number',
    min: 1,
    max: 4 * MIB,
    fallback: 256 * KIB,
    help: 'Default 262 144 (256 KiB), at most 4 194 304 (4 MiB).',
  },
  {
    document: 'policy',
    name: 'follow_redirects',
    label: 'Follow redirects (at most 2 hops, each kept under the base URL)',
    kind: 'boolean',
    fallback: false,
  },
  {
    document: 'policy',
    name: 'allow_query_credentials',
    label: 'Allow the credential in the query string (the query mode needs this)',
    kind: 'boolean',
    fallback: false,
    help: 'Query strings reach proxy and server logs; prefer a header mode.',
  },
];

export const httpForm = {
  kind: 'http',
  fields: [...destination, ...credential, ...policy],
} as const;
