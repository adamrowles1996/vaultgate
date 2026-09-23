import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all } from '../storage/query.ts';
import {
  caller,
  createActionsHarness,
  createHttpTarget,
  httpInvocation,
  resultOf,
  storedCalls,
} from '../test-support/actions-fixtures.ts';

import type { DatabaseSync } from 'node:sqlite';

const rowSchema = z.record(z.string(), z.unknown());

/**
Every row of the two trail tables as text, so a stored result would be found wherever it hid.
*/
function storeText(database: DatabaseSync): string {
  return JSON.stringify([
    ...all(database, 'SELECT * FROM action_calls', rowSchema),
    ...all(database, 'SELECT * FROM audit_events', rowSchema),
  ]);
}

describe('what a call leaves behind', () => {
  it('ACT-60 ACT-61 writes every column of the call row and the MCP-13 audit event, results never stored, arguments capped at 4 KiB', async () => {
    const harness = createActionsHarness();
    await createHttpTarget(harness);
    const at = harness.clock.now();
    resultOf(await harness.engine.call(caller(), httpInvocation()));
    expect(storedCalls(harness.database)).toStrictEqual([
      {
        id: 'id-2',
        at,
        targetId: 'id-1',
        targetName: 'api',
        connector: 'http',
        revision: 1,
        tool: 'http_request',
        sessionIdHash: undefined,
        clientId: 'vg_c_agent',
        tokenPrefix: 'aabbccdd0011',
        operation: 'read',
        classification: 'GET',
        arguments: '{"target":"api","method":"GET","path":"/v1/me"}',
        argumentsTruncated: false,
        outputBytes: expect.any(Number) as number,
        outputTruncated: false,
        durationMs: 0,
        outcome: 'ok',
        elicitation: 'not_required',
        confirmationNonce: undefined,
        requestId: 'req-1',
        ip: '203.0.113.9',
      },
    ]);
    expect(harness.audit.at(-1)).toStrictEqual({
      category: 'mcp',
      action: 'http_request',
      outcome: 'ok',
      clientId: 'vg_c_agent',
      tokenPrefix: 'aabbccdd0011',
      requestId: 'req-1',
      ip: '203.0.113.9',
      durationMs: 0,
      details: {
        clientName: 'Agent One',
        target: 'api',
        outcome: 'ok',
        elicitation: 'not_required',
      },
    });
    expect(storeText(harness.database)).not.toContain('"status":200');
    const large = httpInvocation({ body: 'x'.repeat(5000) });
    resultOf(await harness.engine.call(caller(), large));
    expect(storedCalls(harness.database)[1]).toMatchObject({ argumentsTruncated: true });
  });
});
