import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { listActionCalls, type StoredActionCall } from '../audit/actions-query.ts';
import { openTestDatabase } from '../test-support/database.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import {
  type CallRow,
  completeCall,
  encodeArguments,
  INTERRUPTED_OUTCOME,
  isNonceConsumed,
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
  elicitation: 'accepted',
  confirmationNonce: 'nonce-1',
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
    unwrapOk(recordCall(database, { ...ROW, confirmationNonce: undefined }));
    const truncated = openTestDatabase();
    unwrapOk(
      recordCall(truncated, { ...ROW, confirmationNonce: undefined, outputTruncated: true }),
    );
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
        elicitation: 'accepted',
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

  it('ACT-46 consumes the confirmation nonce with the row and refuses a second row with the same nonce, leaving no trace of it', () => {
    const database = openTestDatabase();
    expect(isNonceConsumed(database, 'nonce-1')).toBe(false);
    unwrapOk(recordCall(database, ROW));
    expect(isNonceConsumed(database, 'nonce-1')).toBe(true);
    expect(unwrapFail(recordCall(database, { ...ROW, id: 'call-2' })).code).toBe(
      'confirmation_reused',
    );
    expect(rows(database).map((row) => row.id)).toStrictEqual(['call-1']);
    expect(database.isTransaction).toBe(false);
  });

  it('ACT-60 stores NULL for what a refused call could not know', () => {
    const database = openTestDatabase();
    unwrapOk(
      recordCall(database, {
        ...ROW,
        targetId: undefined,
        connector: undefined,
        revision: undefined,
        operation: undefined,
        classification: undefined,
        confirmationNonce: undefined,
        requestId: undefined,
        ip: undefined,
        outcome: 'denied:unknown_target',
        elicitation: 'not_required',
      }),
    );
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
