/**
 * The `http` connector's form (spec §14.2, §14.3, §14.3a): one descriptor per
 * field of its three documents, in the order the operator reads them,
 * including the `graph` (ACT-81) and `oauth2` (ACT-124) adapters', whose
 * token exchange vaultgate performs itself, and the destination's private
 * trust: a certificate pin (ACT-121) or a private certificate authority in
 * the multi-line box a PEM needs (ACT-122). The adapters share a control
 * wherever their documents share a field's name and meaning, and so do
 * `header` and `oauth2` for the header name and the prefix.
 */
import { HTTP_METHODS } from '../connectors/http/schemas.ts';

import type { FieldDescriptor } from './descriptors.ts';

const KIB = 1024;
const MIB = KIB * KIB;

const MODES = ['bearer', 'basic', 'header', 'query', 'graph', 'oauth2'] as const;
const FIELD_MODES = ['bearer', 'basic', 'header', 'query'] as const;
const NAMED_MODES = ['header', 'query', 'oauth2'] as const;
const GRAPH = ['graph'] as const;
const OAUTH2 = ['oauth2'] as const;
const ADAPTERS = ['graph', 'oauth2'] as const;

const SELECTOR_HELP =
  'A vault field: password, totp, notes, custom.<name> for a hidden custom field, ' +
  'card.number, card.code, identity.<field> or sshKey.privateKey.';

const destination: readonly FieldDescriptor[] = [
  {
    document: 'destination',
    name: 'base_url',
    label: 'Base URL',
    kind: 'text',
    address: 'url',
    required: true,
    help:
      'An https:// origin with an optional path prefix, no query or fragment; http:// only on an ' +
      'internal connection. Every request path is appended to it and must stay under it.',
  },
  {
    document: 'destination',
    name: 'certificate_sha256',
    label: 'Certificate fingerprint (SHA-256)',
    kind: 'text',
    help:
      'Optional, https:// only. Leave this and the authority below empty to verify the API ' +
      'against the system certificate store; give the SHA-256 of its certificate — 64 ' +
      'hexadecimal digits, colons optional — to pin that one certificate instead. A renewed ' +
      'certificate needs a new fingerprint.',
  },
  {
    document: 'destination',
    name: 'ca_pem',
    label: 'Certificate authority (PEM)',
    kind: 'text',
    multiline: true,
    help:
      'Optional, https:// only, and not together with a fingerprint. The PEM of the private ' +
      'authority that signs the API’s certificate, trusted in place of the system store; the base ' +
      'URL’s host must be a name or address that certificate carries.',
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
      'Microsoft Graph token obtained server-side; oauth2: a token vaultgate obtains from any ' +
      'OAuth 2.0 token endpoint, sent as <name>: <prefix><token>.',
  },
  {
    document: 'credential',
    name: 'field',
    label: 'Secret field',
    kind: 'text',
    picker: { role: 'secret', fallback: 'password' },
    when: { field: 'mode', values: FIELD_MODES },
    help: `${SELECTOR_HELP} Used by the bearer, basic, header and query modes.`,
  },
  {
    document: 'credential',
    name: 'username_from',
    label: 'Username field (basic)',
    kind: 'text',
    picker: { role: 'username', fallback: 'login.username' },
    when: { field: 'mode', values: ['basic'] },
    help: 'login.username unless another field holds it. Used by the basic mode.',
  },
  {
    document: 'credential',
    name: 'name',
    label: 'Header or query parameter name',
    kind: 'text',
    when: { field: 'mode', values: NAMED_MODES },
    help: 'Used by the header and query modes, and by oauth2 for its token (default authorization).',
  },
  {
    document: 'credential',
    name: 'prefix',
    label: 'Value prefix',
    kind: 'text',
    verbatim: true,
    when: { field: 'mode', values: NAMED_MODES },
    help:
      'Optional, written before the value exactly as typed, spaces included (for example "Token " ' +
      'with its space). oauth2 writes it before the token: default "Bearer ", ' +
      '"Zoho-oauthtoken " for Zoho.',
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
    name: 'token_url',
    label: 'Token endpoint URL (oauth2)',
    kind: 'text',
    when: { field: 'mode', values: OAUTH2 },
    help:
      'The OAuth 2.0 token endpoint, https:// only (the client secret is sent to it), no query ' +
      'or fragment: for Entra ID, https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token.',
  },
  {
    document: 'credential',
    name: 'client_id',
    label: 'Application (client) id',
    kind: 'text',
    when: { field: 'mode', values: ADAPTERS },
    help: 'graph: the application id, a GUID. oauth2: the client id the provider issued.',
  },
  {
    document: 'credential',
    name: 'client_auth',
    label: 'Client authentication (oauth2)',
    kind: 'select',
    options: [
      { value: 'post', label: 'post: client id and secret in the form' },
      { value: 'basic', label: 'basic: HTTP Basic' },
    ],
    fallback: 'post',
    when: { field: 'mode', values: OAUTH2 },
    help: 'How the client authenticates to the token endpoint; Xero wants basic.',
  },
  {
    document: 'credential',
    name: 'grant',
    label: 'Grant',
    kind: 'select',
    options: [
      { value: 'client_credentials', label: 'client_credentials' },
      { value: 'refresh_token', label: 'refresh_token' },
    ],
    fallback: 'client_credentials',
    when: { field: 'mode', values: ADAPTERS },
    help: 'Used by the graph and oauth2 modes.',
  },
  {
    document: 'credential',
    name: 'scope',
    label: 'Scope',
    kind: 'text',
    when: { field: 'mode', values: ADAPTERS },
    help:
      'graph: default https://graph.microsoft.com/.default. oauth2: sent only when set, for ' +
      'example https://analysis.windows.net/powerbi/api/.default.',
  },
  {
    document: 'credential',
    name: 'secret_field',
    label: 'Client secret field',
    kind: 'text',
    picker: { role: 'secret', fallback: 'password' },
    when: { field: 'mode', values: ADAPTERS },
    help: `${SELECTOR_HELP} Used by the graph and oauth2 modes.`,
  },
  {
    document: 'credential',
    name: 'refresh_token_field',
    label: 'Refresh token field',
    kind: 'text',
    picker: { role: 'secret', optional: true },
    when: { field: 'mode', values: ADAPTERS },
    help:
      'Required for the refresh_token grant, and on oauth2 used by it only; a hidden custom ' +
      'field is the expected home.',
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
