/**
 * `http_request` as the connector declares it (spec §13.6.3): the operation
 * arguments the engine parses (ACT-20), the strict result (ACT-21), the
 * LLM-facing description (ACT-17) and the annotations of the 13.6.1 row
 * (ACT-18). The MCP layer puts `target` in front of the arguments.
 */
import { z } from 'zod';

import { HTTP_METHODS } from './schemas.ts';

import type { ConnectorTool } from '../connector.ts';

const MAX_PATH_BYTES = 2048;
const MAX_HEADERS = 32;
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/;

/**
RFC 9110 field values: tab, visible ASCII and obs-text; never CR or LF, which end a field.
*/
const HEADER_VALUE = /^[\t\u{20}-\u{7E}\u{80}-\u{FF}]*$/u;

/**
Whitespace, a backslash (which a URL parser turns into a slash), a fragment or a control character.
*/
const PATH_REFUSED = /[\s\\#\p{Cc}]/u;

/**
 * An encoded separator. ACT-35 normalises a path by decoding the unreserved
 * characters only, so `%2F` is still an escape when the dot segments are
 * removed and when a `*` is matched — neither treats it as a boundary — while
 * a destination that decodes it before routing reads it as one. The pattern
 * would then be matched against a shorter path than the server resolves, so
 * the escape is refused rather than normalised.
 */
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;

function pathProblem(path: string): string | undefined {
  if (!path.startsWith('/')) {
    return 'must start with /';
  }
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) {
    return 'must be at most 2 KiB';
  }
  if (PATH_REFUSED.test(path)) {
    return 'must not contain whitespace, a backslash, a fragment or a control character';
  }
  const queryAt = path.indexOf('?');
  const pathPart = queryAt === -1 ? path : path.slice(0, queryAt);
  if (ENCODED_SEPARATOR.test(pathPart)) {
    return 'must not percent-encode a slash or a backslash (%2F, %5C) before the query string';
  }
  if (pathPart.split('/').includes('..')) {
    return 'must not contain a .. segment';
  }
  // A leading `//` is a protocol-relative URL, which would name another host (ACT-20).
  return pathPart.includes('//') ? 'must not contain an empty segment (//)' : undefined;
}

function headersProblem(headers: Readonly<Record<string, string>>): string | undefined {
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) {
    return `must have at most ${MAX_HEADERS} entries`;
  }
  const bad = entries.find(([name, value]) => !HEADER_NAME.test(name) || !HEADER_VALUE.test(value));
  return bad === undefined ? undefined : `"${bad[0]}" is not a valid header name and value`;
}

const pathSchema = z
  .string()
  .superRefine((path, context) => {
    const problem = pathProblem(path);
    if (problem !== undefined) {
      context.addIssue({ code: 'custom', message: problem });
    }
  })
  .describe(
    'The request path and optional query string, starting with /, appended to the target base URL. ' +
      'No scheme, host, fragment, .. segment, empty segment (//) or percent-encoded slash ' +
      '(%2F, %5C) in the path; at most 2 KiB.',
  );

const headersSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, context) => {
    const problem = headersProblem(headers);
    if (problem !== undefined) {
      context.addIssue({ code: 'custom', message: problem });
    }
  })
  .describe(
    'Request headers, at most 32. Names are matched case-insensitively against the target policy; ' +
      'Authorization, Cookie, Host, Content-Length, User-Agent, Transfer-Encoding, Proxy-* and the ' +
      'header the credential occupies are never allowed.',
  );

const bodySchema = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe(
    'The request body: a string sent as is, or a JSON object or array serialised with ' +
      'Content-Type: application/json when you set no content-type header.',
  );

export const httpOperationSchema = z.strictObject({
  method: z
    .enum(HTTP_METHODS)
    .describe('The HTTP method; the target policy lists the allowed ones.'),
  path: pathSchema,
  headers: headersSchema.optional(),
  body: bodySchema.optional(),
});

export type HttpOperation = z.output<typeof httpOperationSchema>;

export const httpOutputSchema = z.strictObject({
  status: z
    .number()
    .int()
    .describe('The HTTP status. A non-2xx status, including 401 and 403, is a normal result.'),
  headers: z
    .record(z.string(), z.string())
    .describe('The response headers the target policy lets you see, lower-cased.'),
  body: z.string().describe('The response body as text, or base64 when body_encoding is "base64".'),
  body_encoding: z
    .literal('base64')
    .optional()
    .describe('Present when the body is binary (not a textual media type in valid UTF-8).'),
  bytes: z
    .number()
    .int()
    .describe(
      'Body bytes received before the cap; when truncated, the destination sent at least this many.',
    ),
  truncated: z.boolean().describe('True when the body was cut at the target output limit.'),
  duration_ms: z.number().int(),
});

export const HTTP_REQUEST_DESCRIPTION =
  'Sends one HTTP request to a target the operator configured, signed with a credential from the ' +
  'vault that you never see. `target` must be a name returned by actions_list_targets; `method` ' +
  'must be one the target policy allows; `path` (with an optional query string) is appended to ' +
  'the target base URL and must stay under it; `headers` may carry only the names the policy ' +
  'allows and never Authorization, Cookie, Host or the header the credential occupies; `body` is ' +
  'a string, or a JSON object or array sent as application/json. Returns the status, the ' +
  'response headers the policy exposes, the body (text, or base64 with body_encoding when ' +
  'binary; cut at the output limit with truncated: true), its byte count and the duration. It ' +
  'never returns the credential: any echo of it is replaced by [redacted:<field>]. A non-2xx ' +
  'status is a normal result, not an error: a 401 or 403 means the destination refused the ' +
  'request and is reported as such, never as authentication_failed. Errors are reserved for a ' +
  'destination that could not be reached (connection_failed, tls_error, timeout, ' +
  'destination_refused). Redirects are returned as they are unless the target policy follows ' +
  'them. Every method other than GET, HEAD and OPTIONS is a write: the operator may require a ' +
  'human confirmation for it, which you cannot supply yourself.';

export const httpRequestTool: ConnectorTool<HttpOperation> = {
  name: 'http_request',
  scope: 'actions:http',
  description: HTTP_REQUEST_DESCRIPTION,
  annotations: {
    title: 'HTTP request',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: httpOperationSchema,
  outputSchema: httpOutputSchema,
};
