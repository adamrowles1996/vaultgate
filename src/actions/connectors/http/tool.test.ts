import { describe, expect, it } from 'vitest';

import { connectSdkClient, createActionsApp } from '../../../test-support/actions-app.ts';
import { createHttpTarget, storedCalls } from '../../../test-support/actions-fixtures.ts';
import {
  bodyText,
  echoResponse,
  fakeTransport,
  httpConnectorOver,
  textResponse as text,
} from '../../../test-support/http-connector.ts';
import { CANARY } from '../../../test-support/vault-fixture.ts';

describe('http_request through the MCP client SDK', () => {
  it('ACT-40 a POST on a target that allows it runs at once, asking no one, and reaches the destination with the body and the credential', async () => {
    const fake = fakeTransport((request) => echoResponse(request, 201));
    const { app, harness, issue } = createActionsApp({ runtime: httpConnectorOver(fake) });
    await createHttpTarget(harness, {
      policy: { allowed_methods: ['GET', 'POST'] },
    });
    const client = await connectSdkClient(app, { token: issue(['actions:http']) });
    const result = await client.callTool({
      name: 'http_request',
      arguments: { target: 'api', method: 'POST', path: '/items', body: { name: 'x' } },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 201,
      truncated: false,
      bytes: expect.any(Number) as number,
    });
    const body = String((result.structuredContent as Record<string, unknown>)['body']);
    expect(body).toContain('"method":"POST"');
    expect(body).toContain('"authorization":"Bearer [redacted:password]"');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/v1/items',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CANARY.password}` },
    });
    expect(bodyText(fake.requests[0]!)).toBe('{"name":"x"}');
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'ok', elicitation: 'not_required', operation: 'write', classification: 'POST' },
    ]);
  });

  it('ACT-17 ACT-18 ACT-15 tools/list advertises http_request with target first, the 13.6.1 annotations and strict schemas', async () => {
    const fake = fakeTransport(() => text(200, 'ok'));
    const { app, issue } = createActionsApp({ runtime: httpConnectorOver(fake) });
    const client = await connectSdkClient(app, { token: issue(['actions:http']) });
    const listed = await client.listTools();
    await client.close();
    const tool = listed.tools.find((candidate) => candidate.name === 'http_request');
    expect(tool?.annotations).toStrictEqual({
      title: 'HTTP request',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tool?.description).toContain('401');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['target', 'method', 'path'],
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toStrictEqual([
      'target',
      'method',
      'path',
      'headers',
      'body',
    ]);
    expect(tool?.outputSchema).toMatchObject({ additionalProperties: false });
    expect(Object.keys(tool?.outputSchema?.['properties'] ?? {})).toStrictEqual([
      'status',
      'headers',
      'body',
      'body_encoding',
      'bytes',
      'truncated',
      'duration_ms',
    ]);
  });
});
