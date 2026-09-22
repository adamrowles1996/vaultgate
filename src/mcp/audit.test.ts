import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger.ts';

import { type AuditEvent, LoggingAuditSink } from './audit.ts';

const EVENT: AuditEvent = {
  timestamp: '2026-09-22T12:00:00.000Z',
  clientId: 'https://agent.example/client.json',
  clientName: 'Example Agent',
  subject: 'operator-1',
  tokenId: '000000000abc',
  tool: 'get_secret',
  outcome: 'ok',
  itemId: 'item-login',
  field: 'password',
  durationMs: 3,
  requestId: 'req-1',
  sourceIp: '10.0.0.1',
};

describe('LoggingAuditSink', () => {
  it('MCP-13 writes one structured line per event with the event shape and nothing else', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    new LoggingAuditSink(createLogger('info', sink)).record(EVENT);
    const line = JSON.parse(chunks.join('')) as { audit: AuditEvent; msg: string };
    expect(line.msg).toBe('tool call');
    expect(line.audit).toStrictEqual(EVENT);
  });
});
