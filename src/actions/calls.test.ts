import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { listActionCalls, type StoredActionCall } from '../audit/actions-query.ts';
import { openTestDatabase } from '../test-support/database.ts';

import {
  type CallRow,
  completeCall,
  encodeArguments,
  INTERRUPTED_OUTCOME,
  recordCall,
} from './calls.ts';

import type { DatabaseSync } from 'node:sqlite';

const ROW: CallRow = {
  id: 'call-1',
  at: 1000,
  targetId: 'target-1',
  targetName: 'api',
  connector: 'http',
  revision: 2,
  tool: 'http_request',
  sessionIdHash: undefined,
  clientId: 'vg_c_agent',
  tokenPrefix: 'aabbccdd0011',
  operation: 'write',
  classification: 'POST',
  arguments: { target: 'api', method: 'POST' },
  outputBytes: 0,
  outputTruncated: false,
  durationMs: 0,
  outcome: INTERRUPTED_OUTCOME,
  requestId: 'req-1',
  ip: '203.0.113.9',
};

function rows(database: DatabaseSync): readonly StoredActionCall[] {
  return listActionCalls(database, { from: 0, to: 10_000, limit: 10 }).records;
}

describe('encodeArguments', () => {
  it('ACT-60 ACT-63 stores the arguments as JSON cut at 4 KiB, saying how much is missing and the digest of the whole', () => {
    expect(encodeArguments({ a: 1 })).toStrictEqual({ text: '{"a":1}', truncated: false });
    const whole = JSON.stringify({ body: 'x'.repeat(5000) });
    const big = encodeArguments({ body: 'x'.repeat(5000) });
    expect(big.truncated).toBe(true);
    expect(big.text.startsWith(whole.slice(0, 4096))).toBe(true);
    const sha256 = createHash('sha256').update(whole, 'utf8').digest('hex');
    expect(big.text).toContain(
      `\n[vaultgate: 4096 of ${String(Buffer.byteLength(whole))} bytes shown; sha256 of the whole is ${sha256}]`,
    );
  });
});

describe('recordCall', () => {
  it('ACT-60 writes every column and completeCall fills in the outcome, output and duration', () => {
    const database = openTestDatabase();
    recordCall(database, ROW);
    const truncated = openTestDatabase();
    recordCall(truncated, { ...ROW, outputTruncated: true });
    expect(rows(truncated).map((row) => row.outputTruncated)).toStrictEqual([true]);
    expect(rows(database)).toStrictEqual([
      {
        id: 'call-1',
        at: 1000,
        targetId: 'target-1',
        targetName: 'api',
        connector: 'http',
        revision: 2,
        tool: 'http_request',
        sessionIdHash: undefined,
        clientId: 'vg_c_agent',
        tokenPrefix: 'aabbccdd0011',
        operation: 'write',
        classification: 'POST',
        arguments: '{"target":"api","method":"POST"}',
        argumentsTruncated: false,
        outputBytes: 0,
        outputTruncated: false,
        durationMs: 0,
        outcome: 'error:interrupted',
        elicitation: 'not_required',
        confirmationNonce: undefined,
        requestId: 'req-1',
        ip: '203.0.113.9',
      },
    ]);
    completeCall(database, 'call-1', {
      outcome: 'ok',
      outputBytes: 42,
      outputTruncated: true,
      durationMs: 7,
    });
    expect(rows(database)[0]).toMatchObject({
      outcome: 'ok',
      outputBytes: 42,
      outputTruncated: true,
      durationMs: 7,
    });
  });

  it('ACT-60 records every call as not_required with no nonce, since vaultgate asks no one to approve a call', () => {
    const database = openTestDatabase();
    recordCall(database, ROW);
    recordCall(database, { ...ROW, id: 'call-2', at: 1001 });
    expect(rows(database).map((row) => [row.elicitation, row.confirmationNonce])).toStrictEqual([
      ['not_required', undefined],
      ['not_required', undefined],
    ]);
  });

  it('ACT-60 stores NULL for what a refused call could not know', () => {
    const database = openTestDatabase();
    recordCall(database, {
      ...ROW,
      targetId: undefined,
      connector: undefined,
      revision: undefined,
      operation: undefined,
      classification: undefined,
      requestId: undefined,
      ip: undefined,
      outcome: 'denied:unknown_target',
    });
    expect(rows(database)[0]).toMatchObject({
      targetId: undefined,
      connector: undefined,
      revision: undefined,
      operation: undefined,
      classification: undefined,
      requestId: undefined,
      ip: undefined,
      outcome: 'denied:unknown_target',
    });
  });
});
