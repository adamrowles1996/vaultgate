/**
 * An `http` connector whose destination is a fake that echoes its request
 * (ACT-53, ACT-75): the request the real connector would send, with the
 * injected credential in its injection point and in the encodings a hostile
 * destination might echo, comes back as the body, so the scrubber and the
 * canary suite are proven end to end through the engine. The real `http`
 * runtime lands in M9's third pull request; this fake shares its schemas.
 */
import { z } from 'zod';

import {
  type HttpCredential,
  type HttpDestination,
  type HttpPolicy,
  httpSchemas,
} from '../actions/connectors/http/schemas.ts';
import { ActionError, type ActionErrorCode } from '../actions/errors.ts';
import { httpSubject, isPatternMatch, type PolicyDecision } from '../actions/policy.ts';
import { fail, ok, type Result } from '../result.ts';

import type {
  Connector,
  ConnectorOutput,
  ConnectorTool,
  OperationRequest,
  RunContext,
  TargetCapabilities,
} from '../actions/connectors/connector.ts';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const echoOperationSchema = z.strictObject({
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export type EchoOperation = z.output<typeof echoOperationSchema>;

/**
The ACT-21 result as the engine assembles it: the connector's fields, the captured body, `truncated` and `duration_ms`.
*/
const echoOutputSchema = z.strictObject({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  bytes: z.number().int(),
  truncated: z.boolean(),
  duration_ms: z.number().int(),
});

/**
The `http_request` surface of 13.6.1 and ACT-17, as the real connector will declare it.
*/
export const echoTool: ConnectorTool<EchoOperation> = {
  name: 'http_request',
  scope: 'actions:http',
  description:
    'Sends one HTTP request to a target the operator configured, signed with a credential from the ' +
    'vault that you never see. `target` must be a name returned by actions_list_targets; `path` is ' +
    'appended to the target base URL. Returns the status, the allowed response headers, the body ' +
    '(capped, `truncated` when cut), its size and the duration; never returns the credential. A ' +
    'non-2xx status is a normal result. The operator may require a human confirmation for every ' +
    'non-GET call, which you cannot supply yourself.',
  annotations: {
    title: 'HTTP request',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: echoOperationSchema,
  outputSchema: echoOutputSchema,
};

export interface EchoBehaviour {
  /**
  `echo` answers with the request; `hang` waits for the abort signal; `fail` returns `failWith`
  with the injected value in its detail; `throw` throws an Error with the value in the message;
  `throw_text` throws a bare string, as a careless library might.
  */
  mode: 'echo' | 'hang' | 'fail' | 'throw' | 'throw_text';
  failWith: ActionErrorCode;
  /**
  How many times the echoed document is repeated, to exceed `max_output_bytes`.
  */
  repeat: number;
  /**
  What `capabilities` adds beyond the operations (ACT-19's `engine` and `unrestricted`).
  */
  advertise: Pick<TargetCapabilities, 'engine' | 'unrestricted'>;
  /**
  Extra fields of the connector's result, such as a `truncated: true` a row cap would set.
  */
  result: Readonly<Record<string, unknown>>;
}

type EchoContext = RunContext<HttpDestination, HttpCredential, HttpPolicy>;

export interface EchoConnector extends Connector<
  HttpDestination,
  HttpCredential,
  HttpPolicy,
  EchoOperation
> {
  readonly behaviour: EchoBehaviour;
  /**
  Every run context handed over, so tests can check the pinned address and the zeroed buffers.
  */
  readonly contexts: EchoContext[];
}

function injectedText(context: EchoContext): string {
  const credential = context.credential;
  const field = credential.mode === 'graph' ? credential.secret_field : credential.field;
  return context.injected.value(field)?.toString('utf8') ?? '';
}

interface Injection {
  readonly header?: readonly [name: string, value: string];
  readonly query?: string;
}

/**
The value in its injection point (ACT-79): an `Authorization` or named header, or a query parameter.
*/
function injection(credential: HttpCredential, value: string, username = ''): Injection {
  switch (credential.mode) {
    case 'bearer':
    case 'graph': {
      return { header: ['authorization', `Bearer ${value}`] };
    }
    case 'basic': {
      const pair = Buffer.from(`${username}:${value}`).toString('base64');
      return { header: ['authorization', `Basic ${pair}`] };
    }
    case 'header': {
      return { header: [credential.name, `${credential.prefix ?? ''}${value}`] };
    }
    case 'query': {
      return { query: `${credential.name}=${encodeURIComponent(value)}` };
    }
  }
}

/**
The request as the destination would see it, plus the value in the encodings a hostile one might echo.
*/
function requestDocument(context: EchoContext, operation: EchoOperation): Record<string, unknown> {
  const value = injectedText(context);
  const injected = injection(context.credential, value, context.injected.username);
  const headers: Record<string, string> = { ...operation.headers };
  if (injected.header !== undefined) {
    headers[injected.header[0]] = injected.header[1];
  }
  const separator = operation.path.includes('?') ? '&' : '?';
  const path =
    injected.query === undefined
      ? operation.path
      : `${operation.path}${separator}${injected.query}`;
  return {
    method: operation.method,
    path,
    headers,
    body: operation.body,
    host: context.pinned[0]?.host,
    address: context.pinned[0]?.address,
    echoes: {
      base64: Buffer.from(value).toString('base64'),
      base64url: Buffer.from(value).toString('base64url'),
      form: new URLSearchParams([['v', value]]).toString(),
      json: JSON.stringify(value),
    },
  };
}

function authorize(
  request: OperationRequest<HttpDestination, HttpCredential, HttpPolicy>,
  operation: EchoOperation,
): PolicyDecision {
  const { policy } = request;
  if (!policy.allowed_methods.includes(operation.method)) {
    return { allowed: false, reason: 'method' };
  }
  const subject = httpSubject(operation.path);
  if (
    subject === undefined ||
    policy.allowed_paths.every((pattern) => !isPatternMatch(pattern, subject, 'path'))
  ) {
    return { allowed: false, reason: 'path' };
  }
  const names = Object.keys(operation.headers ?? {}).map((name) => name.toLowerCase());
  if (names.some((name) => !policy.allowed_request_headers.includes(name))) {
    return { allowed: false, reason: 'header' };
  }
  if (Buffer.byteLength(operation.body ?? '') > policy.max_body_bytes) {
    return { allowed: false, reason: 'body_size' };
  }
  return { allowed: true, operation: READ_METHODS.has(operation.method) ? 'read' : 'write' };
}

function capabilities(
  policy: HttpPolicy,
  advertise: EchoBehaviour['advertise'],
): TargetCapabilities {
  const operations = policy.allowed_methods.map((method) => ({
    operation: READ_METHODS.has(method) ? ('read' as const) : ('write' as const),
    scope: 'actions:http' as const,
  }));
  return { operations, ...advertise };
}

function waitForAbort(signal: AbortSignal): Promise<Result<never, ActionError>> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      resolve(fail(new ActionError('timeout')));
    });
  });
}

function echo(
  context: EchoContext,
  operation: EchoOperation,
  behaviour: EchoBehaviour,
): Result<ConnectorOutput, ActionError> {
  const document = JSON.stringify(requestDocument(context, operation));
  const limit = context.outputLimit.maxBytes + context.outputLimit.guardBytes;
  const body = Buffer.from(document.repeat(behaviour.repeat), 'utf8');
  return ok({
    result: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bytes: body.length,
      ...behaviour.result,
    },
    captured: { body: body.subarray(0, limit) },
  });
}

export function createEchoConnector(overrides: Partial<EchoBehaviour> = {}): EchoConnector {
  const behaviour: EchoBehaviour = {
    mode: 'echo',
    failWith: 'upstream_error',
    repeat: 1,
    advertise: {},
    result: {},
    ...overrides,
  };
  const contexts: EchoConnector['contexts'] = [];
  return {
    ...httpSchemas,
    behaviour,
    contexts,
    tools: [echoTool],
    capabilities: (_destination, policy) => capabilities(policy, behaviour.advertise),
    authorize,
    describe: (_request, operation) => ({
      summary: `${operation.method} ${operation.path}`,
      classification: operation.method,
    }),
    run(context, operation): Promise<Result<ConnectorOutput, ActionError>> {
      contexts.push(context);
      switch (behaviour.mode) {
        case 'hang': {
          return waitForAbort(context.signal);
        }
        case 'fail': {
          const error = new ActionError(behaviour.failWith, { message: injectedText(context) });
          return Promise.resolve(fail(error));
        }
        case 'throw': {
          throw new Error(`connector crashed while holding ${injectedText(context)}`);
        }
        case 'throw_text': {
          const thrown: unknown = `text ${injectedText(context)}`;
          throw thrown;
        }
        case 'echo': {
          return Promise.resolve(echo(context, operation, behaviour));
        }
      }
    },
  };
}
