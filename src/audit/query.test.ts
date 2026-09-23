import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { runMaintenance } from '../storage/maintenance.ts';
import { openTestDatabase } from '../test-support/database.ts';
import { captureLogger } from '../test-support/logging.ts';

import { exportAuditEvents, listAuditEvents } from './query.ts';
import { StoreAuditSink } from './store-sink.ts';

import type { AuditEvent } from './event.ts';
import type { ExportFormat } from './format.ts';
import type { DatabaseSync } from 'node:sqlite';

const T = Date.parse('2026-09-22T12:00:00Z');
const DAY = 86_400_000;
const RETENTION_DAYS = 365;
const WINDOW = { from: T - DAY, to: T + DAY };
const ALL_TIME = { from: 0, to: Number.MAX_SAFE_INTEGER };

const LOGIN: AuditEvent = {
  category: 'identity',
  action: 'login.succeeded',
  outcome: 'ok',
  operatorId: 'operator-1',
  ip: '203.0.113.7',
  requestId: 'req-login',
  details: { method: 'totp' },
};

interface Seeded {
  readonly database: DatabaseSync;
  /**
  Records one event at `at`; ids count up so ties on `at` have a known order.
  */
  readonly record: (at: number, event?: AuditEvent) => void;
}

function seeded(): Seeded {
  const database = openTestDatabase();
  const clock = { now: T };
  let ids = 0;
  const sink = new StoreAuditSink({
    database,
    logger: captureLogger().logger,
    now: () => clock.now,
    newId: () => {
      ids += 1;
      return `id-${String(ids).padStart(3, '0')}`;
    },
  });
  return {
    database,
    record: (at, event = LOGIN) => {
      clock.now = at;
      sink.record(event);
    },
  };
}

const TERMINATOR: Readonly<Record<ExportFormat, string>> = { jsonl: '\n', csv: '\r\n' };

/**
The export as whole lines, each still ending in its terminator.
*/
async function lines(database: DatabaseSync, format: ExportFormat, range = WINDOW) {
  const output = await text(exportAuditEvents(database, range, format));
  return output
    .split(TERMINATOR[format])
    .slice(0, -1)
    .map((line) => line + TERMINATOR[format]);
}

describe('listAuditEvents', () => {
  it('returns the window newest first, from inclusive and to exclusive', () => {
    const { database, record } = seeded();
    record(WINDOW.from - 1);
    record(WINDOW.from);
    record(T);
    record(WINDOW.to - 1);
    record(WINDOW.to);
    const page = listAuditEvents(database, { ...WINDOW, limit: 10 });
    expect(page.records.map((event) => [event.id, event.at])).toStrictEqual([
      ['id-004', WINDOW.to - 1],
      ['id-003', T],
      ['id-002', WINDOW.from],
    ]);
    expect(page.next).toBeUndefined();
  });

  it('maps every column back, absent ones as undefined and details parsed', () => {
    const { database, record } = seeded();
    record(T);
    record(T, { category: 'mcp', action: 'list_folders', outcome: 'error:unavailable' });
    const { records: events } = listAuditEvents(database, { ...WINDOW, limit: 10 });
    expect(events).toStrictEqual([
      {
        id: 'id-002',
        at: T,
        category: 'mcp',
        action: 'list_folders',
        outcome: 'error:unavailable',
        operatorId: undefined,
        clientId: undefined,
        tokenPrefix: undefined,
        itemId: undefined,
        field: undefined,
        requestId: undefined,
        ip: undefined,
        durationMs: undefined,
        details: undefined,
      },
      {
        id: 'id-001',
        at: T,
        ...LOGIN,
        clientId: undefined,
        tokenPrefix: undefined,
        itemId: undefined,
        field: undefined,
        durationMs: undefined,
      },
    ]);
  });

  it('pages by keyset on (at, id) so equal timestamps never repeat or skip', () => {
    const { database, record } = seeded();
    for (const at of [T, T, T + 1, T + 1, T + 2]) {
      record(at);
    }
    const first = listAuditEvents(database, { ...WINDOW, limit: 2 });
    const second = listAuditEvents(database, { ...WINDOW, limit: 2, cursor: first.next });
    const third = listAuditEvents(database, { ...WINDOW, limit: 2, cursor: second.next });
    expect(first.records.map((event) => event.id)).toStrictEqual(['id-005', 'id-004']);
    expect(first.next).toStrictEqual({ at: T + 1, id: 'id-004' });
    expect(second.records.map((event) => event.id)).toStrictEqual(['id-003', 'id-002']);
    expect(second.next).toStrictEqual({ at: T, id: 'id-002' });
    expect(third.records.map((event) => event.id)).toStrictEqual(['id-001']);
    expect(third.next).toBeUndefined();
  });

  it('STORE-6 MCP-15 no longer lists an event once retention has retired it', () => {
    const { database, record } = seeded();
    record(T - RETENTION_DAYS * DAY);
    record(T - RETENTION_DAYS * DAY - 1);
    const before = listAuditEvents(database, { ...ALL_TIME, limit: 10 });
    const counts = runMaintenance(database, new Date(T), RETENTION_DAYS);
    const after = listAuditEvents(database, { ...ALL_TIME, limit: 10 });
    expect(before.records).toHaveLength(2);
    expect(counts.audit_events).toBe(1);
    expect(after.records.map((event) => event.id)).toStrictEqual(['id-001']);
  });
});

describe('exportAuditEvents', () => {
  it('OPS-5 streams JSON Lines with the timestamp as ISO 8601 and no header', async () => {
    const { database, record } = seeded();
    record(T);
    record(T + 1, { category: 'mcp', action: 'get_item', outcome: 'ok', itemId: 'item-1' });
    const output = await lines(database, 'jsonl');
    expect(output).toStrictEqual([
      '{"id":"id-002","at":"2026-09-22T12:00:00.001Z","category":"mcp","action":"get_item","outcome":"ok","itemId":"item-1"}\n',
      '{"id":"id-001","at":"2026-09-22T12:00:00.000Z","category":"identity","action":"login.succeeded","outcome":"ok","operatorId":"operator-1","requestId":"req-login","ip":"203.0.113.7","details":{"method":"totp"}}\n',
    ]);
  });

  it('OPS-5 streams CSV per RFC 4180: header, CRLF, quoting only where needed', async () => {
    const { database, record } = seeded();
    record(T, {
      category: 'identity',
      action: 'request.denied',
      outcome: 'denied',
      ip: '203.0.113.7',
      durationMs: 12,
      details: { reason: 'missing or stale synchroniser token', path: '/account' },
    });
    record(T + 1, { category: 'mcp', action: 'search', outcome: 'ok', clientId: 'a,"b"\nc' });
    const output = await lines(database, 'csv');
    expect(output).toStrictEqual([
      'id,at,category,action,outcome,operatorId,clientId,tokenPrefix,itemId,field,requestId,ip,durationMs,details\r\n',
      'id-002,2026-09-22T12:00:00.001Z,mcp,search,ok,,"a,""b""\nc",,,,,,,\r\n',
      'id-001,2026-09-22T12:00:00.000Z,identity,request.denied,denied,,,,,,,203.0.113.7,12,"{""reason"":""missing or stale synchroniser token"",""path"":""/account""}"\r\n',
    ]);
  });

  it('exports only the header when the window is empty', async () => {
    const { database } = seeded();
    expect(await lines(database, 'csv')).toHaveLength(1);
    expect(await lines(database, 'jsonl')).toStrictEqual([]);
  });

  it('walks every page of a window larger than one query', async () => {
    const { database, record } = seeded();
    for (let index = 0; index < 501; index += 1) {
      record(T + index);
    }
    const output = await lines(database, 'jsonl');
    expect(output).toHaveLength(501);
    expect(output[0]).toContain('"id":"id-501"');
    expect(output.at(-1)).toContain('"id":"id-001"');
    expect(new Set(output).size).toBe(501);
  });
});
