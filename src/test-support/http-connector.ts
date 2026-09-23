/**
 * What the `http` connector's contract tests run against (ACT-75, ACT-78):
 * a scripted pinned transport that records every request, a fake
 * destination that echoes its request back in the encodings a hostile one
 * might use (ACT-53), and a `RunContext` built by hand so `run` can be
 * driven without the engine.
 */
import { z } from 'zod';

import { createHttpConnector, type HttpConnector } from '../actions/connectors/http/index.ts';
import {
  type HttpCredential,
  type HttpDestination,
  type HttpPolicy,
  httpPolicySchema,
} from '../actions/connectors/http/schemas.ts';
import { createInjectedValues, createScrubber, type InjectedEntry } from '../actions/scrub.ts';
import { all } from '../storage/query.ts';

import {
  type ActionsHarness,
  createActionsHarness,
  type HarnessOptions,
  PUBLIC_ADDRESS,
} from './actions-fixtures.ts';
import { captureLogger } from './logging.ts';
import { CANARY } from './vault-fixture.ts';

import type { ConnectorOutput } from '../actions/connectors/connector.ts';
import type { HttpOperation } from '../actions/connectors/http/operation.ts';
import type { HttpRunContext } from '../actions/connectors/http/run.ts';
import type { ActionError } from '../actions/errors.ts';
import type { PinnedFetch, PinnedRequest } from '../net/pinned-https.ts';
import type { Result } from '../result.ts';

export type Answer = Response | Error | 'hang';

export interface FakeTransport {
  readonly transport: PinnedFetch;
  readonly requests: PinnedRequest[];
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
}

/**
A transport that answers each request from `answer` and keeps every request it was given.
*/
export function fakeTransport(
  answer: (request: PinnedRequest, index: number) => Answer,
): FakeTransport {
  const requests: PinnedRequest[] = [];
  return {
    requests,
    transport: (request) => {
      requests.push(request);
      const outcome = answer(request, requests.length - 1);
      if (outcome === 'hang') {
        return untilAborted(request.signal);
      }
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

export function bodyText(request: PinnedRequest): string {
  return request.body === undefined ? '' : request.body.toString('utf8');
}

/**
Every encoding of a value the scrubber must catch (ACT-51), as a hostile destination might echo it.
*/
function encodings(value: string): readonly string[] {
  return [
    Buffer.from(value, 'utf8').toString('base64'),
    Buffer.from(value, 'utf8').toString('base64url'),
    encodeURIComponent(value),
    new URLSearchParams([['v', value]]).toString(),
    JSON.stringify(value),
  ];
}

/**
 * The request as the destination saw it, plus every header and query value
 * in every encoding: a target whose credential is a canary proves the
 * scrubber over all of them.
 */
export function echoResponse(request: PinnedRequest, status = 200): Response {
  const url = new URL(request.url);
  const values = [...Object.values(request.headers), ...url.searchParams.values()];
  const document = {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: bodyText(request),
    echoes: values.flatMap((value) => encodings(value)),
  };
  return Response.json(document, {
    status,
    headers: { 'content-type': 'application/json', 'x-echo': 'yes' },
  });
}

export interface ContextOptions {
  readonly baseUrl?: string;
  readonly credential?: HttpCredential;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly secret?: string;
  readonly username?: string | undefined;
  readonly pinned?: HttpRunContext['pinned'];
}

export interface BuiltContext {
  readonly context: HttpRunContext;
  readonly controller: AbortController;
  readonly logged: () => readonly Record<string, unknown>[];
}

/**
A bearer target on the fixture password with every path allowed, unless told otherwise.
*/
export function httpRunContext(options: ContextOptions = {}): BuiltContext {
  const destination: HttpDestination = {
    base_url: options.baseUrl ?? 'https://api.example.com/v1',
  };
  const credential = options.credential ?? { mode: 'bearer', field: 'password' };
  const policy: HttpPolicy = httpPolicySchema.parse({ allowed_paths: ['/**'], ...options.policy });
  const field = credential.mode === 'graph' ? credential.secret_field : credential.field;
  const entries: InjectedEntry[] = [
    { field, value: Buffer.from(options.secret ?? CANARY.password, 'utf8') },
  ];
  const username = 'username' in options ? options.username : 'alice@example.com';
  const controller = new AbortController();
  const { logger, lines } = captureLogger();
  const context: HttpRunContext = {
    destination,
    credential,
    policy,
    common: policy,
    injected: createInjectedValues(entries, username),
    pinned: options.pinned ?? [
      { host: new URL(destination.base_url).hostname, tls: true, address: PUBLIC_ADDRESS },
    ],
    signal: controller.signal,
    outputLimit: {
      maxBytes: policy.max_output_bytes,
      guardBytes: createScrubber(entries, username).guardBytes,
    },
    logger,
  };
  return { context, controller, logged: lines };
}

/**
The real connector over a fake transport; `version` fixed so the User-Agent is predictable.
*/
export function httpConnectorOver(fake: FakeTransport): HttpConnector {
  return createHttpConnector({ transport: fake.transport, version: '9.9.9' });
}

export function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

export function redirectResponse(
  status: number,
  location: string,
  body: string | null = 'moved',
): Response {
  return new Response(body, { status, headers: { location } });
}

/**
A transport that answers from a script, then `200 never` once the script runs out.
*/
export function scripted(answers: readonly Answer[]): FakeTransport {
  return fakeTransport((_request, index) => answers[index] ?? textResponse(200, 'never'));
}

/**
A destination that redirects the first request to `location` and echoes the second.
*/
export function redirectThenEcho(location: string): FakeTransport {
  const answers = [redirectResponse(302, location)];
  return fakeTransport((request, index) => answers[index] ?? echoResponse(request));
}

export function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const GET_ME: HttpOperation = { method: 'GET', path: '/me' };

export interface Ran {
  readonly fake: FakeTransport;
  readonly built: BuiltContext;
  readonly outcome: Result<ConnectorOutput, ActionError>;
}

/**
One `run` of the real connector over `fake`, without the engine.
*/
export async function runHttp(
  fake: FakeTransport,
  options: ContextOptions = {},
  operation: HttpOperation = GET_ME,
): Promise<Ran> {
  const built = httpRunContext(options);
  const outcome = await httpConnectorOver(fake).run(built.context, operation);
  return { fake, built, outcome };
}

export function urlsOf(fake: FakeTransport): readonly string[] {
  return fake.requests.map((request) => request.url);
}

export interface Over {
  readonly fake: FakeTransport;
  readonly harness: ActionsHarness;
}

/**
An engine harness whose loaded runtime is the real connector over `fake`.
*/
export function harnessOver(
  answer: (request: PinnedRequest, index: number) => Answer,
  options: Omit<HarnessOptions, 'runtime'> = {},
): Over {
  const fake = fakeTransport(answer);
  return { fake, harness: createActionsHarness({ ...options, runtime: httpConnectorOver(fake) }) };
}

const rowSchema = z.record(z.string(), z.unknown());

/**
Every surface a value could leak through, as one string (ACT-53).
*/
export function surfaces(harness: ActionsHarness, results: readonly unknown[]): string {
  return [
    JSON.stringify(results),
    JSON.stringify(all(harness.database, 'SELECT * FROM action_calls', rowSchema)),
    JSON.stringify(all(harness.database, 'SELECT * FROM audit_events', rowSchema)),
    JSON.stringify(harness.audit),
    JSON.stringify(harness.logged()),
  ].join('\n');
}
