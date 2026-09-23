/**
 * The `/mcp` route (spec §06.1, §03.7, §03.9). Order of checks on every request:
 * origin and host (MCP-3), query-string token (OAUTH-31), body cap (MCP-4),
 * bearer verification (OAUTH-32), then for `tools/call` the scope gate
 * (OAUTH-33) and the per-token rate limit (MCP-5), before the SDK handler
 * serves the JSON-RPC exchange with a fresh server for the token's scopes.
 */
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';

import { FixedWindowRateLimiter } from '../net/rate-limit.ts';

import { authenticate, type BearerVerdict } from './bearer.ts';
import { forbiddenResponse, insufficientScopeChallenge } from './challenges.ts';
import { CORS_ALLOW_HEADERS, CORS_EXPOSE_HEADERS, resourceUrls } from './metadata.ts';
import { checkHost, checkOrigin, hasQueryStringToken, resolveSourceIp } from './request-guards.ts';
import { isToolName, missingScopes, requiredScopes, type ToolName } from './scopes.ts';
import { type CallContext, createVaultMcpServer } from './server.ts';

import type { AuditSink } from '../audit/event.ts';
import type { TokenVerifier } from '../auth/token-types.ts';
import type { Config } from '../config/index.ts';
import type { Logger } from '../logger.ts';
import type { VaultClient } from '../vault/client.ts';
import type { RequestIdVariables } from 'hono/request-id';

export interface McpRouteDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly vaultClient: VaultClient;
  readonly tokenVerifier: TokenVerifier;
  readonly auditSink: AuditSink;
  readonly now: () => number;
}

interface McpEnvironment {
  Variables: RequestIdVariables;
}
type McpContext = Context<McpEnvironment>;

const MAX_BODY_BYTES = 256 * 1024;
const TOOL_CALLS_PER_MINUTE = 120;
const ONE_MINUTE_MS = 60_000;
const MS_PER_SECOND = 1000;

const toolCallParameters = z.object({ name: z.string(), arguments: z.unknown().optional() });
const toolCallSchema = z.object({ method: z.literal('tools/call'), params: toolCallParameters });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toAuthInfo(verdict: BearerVerdict): AuthInfo {
  // The raw bearer never travels further than verification (OAUTH-34): the
  // handler context carries the audit-safe token id in its place.
  return {
    token: verdict.token.tokenId,
    clientId: verdict.token.clientId,
    scopes: [...verdict.scopes],
    expiresAt: Math.floor(verdict.token.expiresAt / MS_PER_SECOND),
    resource: new URL(verdict.token.resource),
  };
}

function guardMiddleware(config: Config): MiddlewareHandler<McpEnvironment> {
  return async (context, next) => {
    const origin = checkOrigin(context.req.raw.headers, config);
    const host = origin.ok ? checkHost(context.req.raw, config) : origin;
    if (!host.ok) {
      return context.json({ error: 'forbidden', error_description: host.reason }, 403);
    }
    if (hasQueryStringToken(context.req.url)) {
      const description = 'send the token in the Authorization header';
      return context.json({ error: 'invalid_request', error_description: description }, 400);
    }
    return next();
  };
}

interface Gate {
  readonly dependencies: McpRouteDependencies;
  readonly limiter: FixedWindowRateLimiter;
  readonly metadataUrl: string;
}

function recordDenied(
  gate: Gate,
  context: McpContext,
  verdict: BearerVerdict,
  tool: ToolName,
): void {
  const { config } = gate.dependencies;
  gate.dependencies.auditSink.record({
    category: 'mcp',
    action: tool,
    outcome: 'denied',
    operatorId: verdict.token.subject,
    clientId: verdict.token.clientId,
    tokenPrefix: verdict.token.tokenId,
    requestId: context.get('requestId'),
    ip: resolveSourceIp(context.req.raw, context.env, config),
    durationMs: 0,
    details: { clientName: verdict.token.clientName },
  });
}

/**
OAUTH-33 then MCP-5, only for `tools/call` on a known tool; anything else goes straight to the SDK.
*/
function toolCallGate(
  gate: Gate,
  context: McpContext,
  verdict: BearerVerdict,
  body: unknown,
): Response | undefined {
  const call = toolCallSchema.safeParse(body);
  if (!call.success || !isToolName(call.data.params.name)) {
    return undefined;
  }
  const tool = call.data.params.name;
  const needed = requiredScopes(tool, call.data.params.arguments);
  if (missingScopes(needed, verdict.scopes).length > 0) {
    recordDenied(gate, context, verdict, tool);
    const description = `${tool} requires ${needed.join(' ')}`;
    const challenge = insufficientScopeChallenge(gate.metadataUrl, needed, description);
    return forbiddenResponse(challenge, needed, description);
  }
  const decision = gate.limiter.hit(verdict.token.tokenId);
  return decision.allowed
    ? undefined
    : context.json({ error: 'rate_limited' }, 429, {
        'Retry-After': String(decision.retryAfterSeconds),
      });
}

interface Exchange {
  readonly verdict: BearerVerdict;
  readonly text: string;
  readonly body: unknown;
}

function serve(gate: Gate, context: McpContext, exchange: Exchange): Promise<Response> {
  const { config, logger, now } = gate.dependencies;
  const callContext: CallContext = {
    token: exchange.verdict.token,
    scopes: exchange.verdict.scopes,
    requestId: context.get('requestId'),
    sourceIp: resolveSourceIp(context.req.raw, context.env, config),
  };
  const server = { vault: gate.dependencies.vaultClient, audit: gate.dependencies.auditSink, now };
  const handler = createMcpHandler(() => createVaultMcpServer(server, callContext), {
    onerror: (error) => {
      logger.warn({ err: error, requestId: callContext.requestId }, 'mcp handler error');
    },
  });
  const forwarded = new Request(context.req.url, {
    method: context.req.method,
    headers: context.req.raw.headers,
    ...(exchange.text !== '' && { body: exchange.text }),
  });
  return handler.fetch(forwarded, {
    authInfo: toAuthInfo(exchange.verdict),
    ...(exchange.body !== undefined && { parsedBody: exchange.body }),
  });
}

export function createMcpRoutes(dependencies: McpRouteDependencies): Hono<McpEnvironment> {
  const { config, now } = dependencies;
  const gate: Gate = {
    dependencies,
    limiter: new FixedWindowRateLimiter({
      limit: TOOL_CALLS_PER_MINUTE,
      windowMs: ONE_MINUTE_MS,
      now,
    }),
    metadataUrl: resourceUrls(config).metadata,
  };
  const app = new Hono<McpEnvironment>();

  app.use(
    '/mcp',
    cors({
      origin: '*',
      allowMethods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      exposeHeaders: [...CORS_EXPOSE_HEADERS],
    }),
  );
  app.use('/mcp', guardMiddleware(config));
  app.use(
    '/mcp',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (context) => context.json({ error: 'payload_too_large' }, 413),
    }),
  );

  app.on(['POST', 'GET', 'DELETE'], '/mcp', async (context) => {
    const headers = context.req.raw.headers;
    const verdict = await authenticate(
      headers,
      dependencies.tokenVerifier,
      config,
      gate.metadataUrl,
    );
    if (verdict instanceof Response) {
      return verdict;
    }
    const text = context.req.method === 'POST' ? await context.req.text() : '';
    const body = text === '' ? undefined : parseJson(text);
    return (
      toolCallGate(gate, context, verdict, body) ?? serve(gate, context, { verdict, text, body })
    );
  });

  return app;
}
