import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { all } from '../storage/query.ts';
import { openTestDatabase } from '../test-support/database.ts';
import { captureLogger } from '../test-support/logging.ts';

import { StoreAuditSink } from './store-sink.ts';

import type { AuditEvent } from './event.ts';
import type { DatabaseSync } from 'node:sqlite';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const CANARY = 'canary-7f3a9c1e-never-persisted';

const rowSchema = z.object({
  id: z.string(),
  at: z.number(),
  category: z.string(),
  action: z.string(),
  outcome: z.string(),
  operator_id: z.string().nullable(),
  client_id: z.string().nullable(),
  token_prefix: z.string().nullable(),
  item_id: z.string().nullable(),
  field: z.string().nullable(),
  request_id: z.string().nullable(),
  ip: z.string().nullable(),
  duration_ms: z.number().nullable(),
  details: z.string().nullable(),
});

const FULL_EVENT: AuditEvent = {
  category: 'mcp',
  action: 'get_secret',
  outcome: 'ok',
  operatorId: 'operator-1',
  clientId: 'https://agent.example/client.json',
  tokenPrefix: '000000000abc',
  itemId: 'item-login',
  field: 'password',
  requestId: 'req-1',
  ip: '10.0.0.7',
  durationMs: 3,
  details: { clientName: 'Example Agent', scopes: ['vault:read'], retried: false, attempt: 1 },
};

function rows(database: DatabaseSync) {
  return all(database, 'SELECT * FROM audit_events ORDER BY at, id', rowSchema);
}

function sink(database: DatabaseSync) {
  const { logger, lines } = captureLogger();
  let ids = 0;
  const audit = new StoreAuditSink({
    database,
    logger,
    now: () => NOW,
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
  });
  return { audit, lines };
}

describe('StoreAuditSink', () => {
  it('MCP-13 MCP-14 appends every column of the event as one row', () => {
    const database = openTestDatabase();
    const { audit } = sink(database);
    audit.record(FULL_EVENT);
    expect(rows(database)).toStrictEqual([
      {
        id: 'id-1',
        at: NOW,
        category: 'mcp',
        action: 'get_secret',
        outcome: 'ok',
        operator_id: 'operator-1',
        client_id: 'https://agent.example/client.json',
        token_prefix: '000000000abc',
        item_id: 'item-login',
        field: 'password',
        request_id: 'req-1',
        ip: '10.0.0.7',
        duration_ms: 3,
        details:
          '{"clientName":"Example Agent","scopes":["vault:read"],"retried":false,"attempt":1}',
      },
    ]);
  });

  it('stores an absent optional field as NULL and no details as NULL', () => {
    const database = openTestDatabase();
    const { audit } = sink(database);
    audit.record({ category: 'identity', action: 'login.failed', outcome: 'failure' });
    audit.record({ category: 'identity', action: 'logout', outcome: 'ok', details: {} });
    expect(rows(database).map((row) => [row.id, row.operator_id, row.details])).toStrictEqual([
      ['id-1', null, null],
      ['id-2', null, '{}'],
    ]);
  });

  it('ARCH-4 never persists a credential-named detail or a field outside the event shape', () => {
    const database = openTestDatabase();
    const { audit, lines } = sink(database);
    const smuggled = {
      ...FULL_EVENT,
      password: CANARY,
      arguments: { item_id: CANARY },
      details: {
        reason: 'kept',
        password: CANARY,
        clientSecret: CANARY,
        totp: CANARY,
        csrfToken: CANARY,
        recoveryCode: CANARY,
        cookie: CANARY,
        credential: CANARY,
        tokenKind: 'kept too',
      },
    };
    audit.record(smuggled);
    const [row] = rows(database);
    expect(row?.details).toBe('{"reason":"kept","tokenKind":"kept too"}');
    expect(JSON.stringify(rows(database)) + JSON.stringify(lines())).not.toContain(CANARY);
  });

  it('logs and continues when the row cannot be written', () => {
    const database = openTestDatabase();
    const { audit, lines } = sink(database);
    database.exec('DROP TABLE audit_events');
    expect(() => {
      audit.record(FULL_EVENT);
    }).not.toThrow();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      level: 50,
      msg: 'audit event was not recorded',
      category: 'mcp',
      action: 'get_secret',
      err: { message: 'no such table: audit_events' },
    });
  });

  it('MCP-15 has no update or delete path anywhere in src/audit', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(here).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const mutating = sources.filter((name) =>
      /\b(?:UPDATE|DELETE)\b/.test(readFileSync(join(here, name), 'utf8')),
    );
    expect(sources).toContain('store-sink.ts');
    expect(mutating).toStrictEqual([]);
  });
});
