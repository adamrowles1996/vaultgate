/**
 * One `http_request` on the wire (ACT-80): the request through the pinned
 * transport to the address the engine validated (ACT-55), redirects only
 * when the policy says so and only under `base_url` (ACT-22), the body read
 * up to the cap plus the guard band (ACT-52), the policy timeout through the
 * engine's signal (ACT-59). A redirect vaultgate does not follow is the
 * result, status and `location` included.
 */
import { type PinnedFetch, type PinnedMethod, readBodyCapped } from '../../../net/pinned-https.ts';
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import {
  bearerInjection,
  buildRequest,
  credentialInjection,
  inject,
  type Injection,
  isUnderBase,
  type OutgoingRequest,
  toPinned,
} from './request.ts';
import { toOutput, transportFailure } from './response.ts';

import type { HttpOperation } from './operation.ts';
import type { HttpCredential, HttpDestination, HttpPolicy } from './schemas.ts';
import type { ConnectorOutput, RunContext } from '../connector.ts';
import type { GraphTokens } from '../graph/adapter.ts';

export type HttpRunContext = RunContext<HttpDestination, HttpCredential, HttpPolicy>;

export type HttpRun = (
  context: HttpRunContext,
  operation: HttpOperation,
) => Promise<Result<ConnectorOutput, ActionError>>;

const MAX_HOPS = 2;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const SEE_OTHER = 303;
const MOVED_OR_FOUND: ReadonlySet<number> = new Set([301, 302]);

/**
Fetch's redirect rules: 303 turns everything but HEAD into GET, 301 and 302 turn POST into GET, 307 and 308 keep the method.
*/
function hopMethod(status: number, method: PinnedMethod): PinnedMethod {
  if (status === SEE_OTHER) {
    return method === 'HEAD' ? 'HEAD' : 'GET';
  }
  return method === 'POST' && MOVED_OR_FOUND.has(status) ? 'GET' : method;
}

function parseLocation(location: string, current: URL): URL | undefined {
  try {
    const target = new URL(location, current);
    target.hash = '';
    return target;
  } catch {
    return undefined;
  }
}

function withoutContentType(headers: OutgoingRequest['headers']): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'content-type'));
}

/**
 * The next hop, or `undefined` when the response is not a redirect vaultgate
 * follows: not a redirect status, no usable `location`, or a target outside
 * `base_url`. A hop keeps the agent's headers, drops the body and its content
 * type when the method turns into GET, and carries the credential again: it
 * is under `base_url`, so the same origin and the same pinned address.
 */
function nextHop(
  response: Response,
  current: OutgoingRequest,
  baseUrl: string,
  injection: Injection,
): OutgoingRequest | undefined {
  const location = response.headers.get('location');
  if (location === null || !REDIRECT_STATUSES.has(response.status)) {
    return undefined;
  }
  const target = parseLocation(location, current.url);
  if (target === undefined || !isUnderBase(target, baseUrl)) {
    return undefined;
  }
  const method = hopMethod(response.status, current.method);
  const isKeepsBody = method === current.method;
  const headers = isKeepsBody ? current.headers : withoutContentType(current.headers);
  return {
    ...inject(target, headers, injection),
    method,
    body: isKeepsBody ? current.body : undefined,
  };
}

interface Exchange {
  readonly address: string;
  readonly first: OutgoingRequest;
  readonly injection: Injection;
}

async function exchange(
  transport: PinnedFetch,
  context: HttpRunContext,
  plan: Exchange,
): Promise<Response> {
  let request = plan.first;
  let response = await transport(toPinned(request, plan.address, context.signal));
  for (let hops = 0; hops < MAX_HOPS && context.policy.follow_redirects; hops += 1) {
    const hop = nextHop(response, request, context.destination.base_url, plan.injection);
    if (hop === undefined) {
      break;
    }
    await response.body?.cancel();
    request = hop;
    response = await transport(toPinned(request, plan.address, context.signal));
  }
  return response;
}

const UNAUTHORIZED = 401;

/**
 * The credential in its injection point: a vault value for the mapped modes,
 * an access token the adapter obtains for `graph` (ACT-82). `isRetry` tells
 * the adapter to discard the token it cached.
 */
async function injectionFor(
  tokens: GraphTokens,
  context: HttpRunContext,
  isRetry: boolean,
): Promise<Result<Injection, ActionError>> {
  const { credential } = context;
  if (credential.mode !== 'graph') {
    return credentialInjection(credential, context.injected);
  }
  const token = await tokens.accessToken({ ...context, credential }, isRetry);
  return token.ok ? ok(bearerInjection(token.value)) : token;
}

/**
 * ACT-82: a `401` on a graph target may mean the cached token was revoked
 * before it expired, so one attempt is made with a fresh one. A `401` on
 * that attempt is the result the agent sees, like any other status.
 */
function isStaleToken(context: HttpRunContext, response: Response): boolean {
  return response.status === UNAUTHORIZED && context.credential.mode === 'graph';
}

interface Attempt {
  readonly transport: PinnedFetch;
  readonly version: string;
  readonly tokens: GraphTokens;
  readonly address: string;
}

async function attempt(
  plan: Attempt,
  context: HttpRunContext,
  operation: HttpOperation,
  isRetry: boolean,
): Promise<Result<Response, ActionError>> {
  const injection = await injectionFor(plan.tokens, context, isRetry);
  if (!injection.ok) {
    return injection;
  }
  const first = buildRequest({
    baseUrl: context.destination.base_url,
    operation,
    injection: injection.value,
    version: plan.version,
  });
  if (!first.ok) {
    return first;
  }
  return ok(
    await exchange(plan.transport, context, {
      address: plan.address,
      first: first.value,
      injection: injection.value,
    }),
  );
}

async function readResponse(
  context: HttpRunContext,
  response: Response,
): Promise<Result<ConnectorOutput, ActionError>> {
  const limit = context.outputLimit.maxBytes + context.outputLimit.guardBytes;
  const raw = await readBodyCapped(response, limit);
  return ok(toOutput(response, raw, context.policy, context.outputLimit.maxBytes));
}

/**
`run` of the `http` connector over an injected transport (ACT-78), with the `graph` adapter for that mode.
*/
export function createRun(transport: PinnedFetch, version: string, tokens: GraphTokens): HttpRun {
  return async (context, operation) => {
    const [endpoint] = context.pinned;
    if (endpoint === undefined) {
      return fail(new ActionError('destination_refused', { reason: 'unpinned' }));
    }
    const plan: Attempt = { transport, version, tokens, address: endpoint.address };
    try {
      const first = await attempt(plan, context, operation, false);
      if (!first.ok || !isStaleToken(context, first.value)) {
        return first.ok ? await readResponse(context, first.value) : first;
      }
      await first.value.body?.cancel();
      const retried = await attempt(plan, context, operation, true);
      return retried.ok ? await readResponse(context, retried.value) : retried;
    } catch (error: unknown) {
      return fail(transportFailure(error, context.signal));
    }
  };
}
