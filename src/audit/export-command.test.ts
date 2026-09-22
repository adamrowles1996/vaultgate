import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { openTestDatabase } from '../test-support/database.ts';
import { captureLogger } from '../test-support/logging.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import {
  parseExportArguments,
  parseExportRequest,
  USAGE,
  writeAuditExport,
} from './export-command.ts';
import { StoreAuditSink } from './store-sink.ts';

import type { ExportRequest } from './export-command.ts';

const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-10-01';
const REQUEST: ExportRequest = { from: Date.parse(FROM), to: Date.parse(TO), format: 'jsonl' };

async function collect(request: ExportRequest, hasStore: boolean): Promise<string> {
  const database = openTestDatabase();
  new StoreAuditSink({
    database,
    logger: captureLogger().logger,
    now: () => Date.parse('2026-09-22T12:00:00Z'),
    newId: () => 'id-1',
  }).record({ category: 'identity', action: 'logout', outcome: 'ok' });
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf8'));
  });
  await writeAuditExport(hasStore ? database : undefined, request, output);
  expect(output.writableEnded).toBe(false);
  return chunks.join('');
}

describe('parseExportRequest', () => {
  it('OPS-5 accepts ISO 8601 dates or date-times and defaults the format to JSON Lines', () => {
    expect(unwrapOk(parseExportRequest({ from: FROM, to: TO }))).toStrictEqual(REQUEST);
    expect(unwrapOk(parseExportRequest({ from: FROM, to: TO, format: 'csv' })).format).toBe('csv');
  });

  it('names the first problem it finds', () => {
    const cases = [
      { input: {}, message: 'from is required' },
      { input: { from: FROM }, message: 'to is required' },
      {
        input: { from: 'yesterday', to: TO },
        message: 'from is not an ISO 8601 date or date-time: yesterday',
      },
      {
        input: { from: FROM, to: '2026-13-45' },
        message: 'to is not an ISO 8601 date or date-time: 2026-13-45',
      },
      { input: { from: TO, to: FROM }, message: 'from must be before to' },
      { input: { from: FROM, to: FROM }, message: 'from must be before to' },
      {
        input: { from: FROM, to: TO, format: 'xml' },
        message: 'format must be jsonl or csv, not xml',
      },
      {
        input: { from: FROM, to: TO, format: 'toString' },
        message: 'format must be jsonl or csv, not toString',
      },
    ];
    expect(cases.map(({ input }) => unwrapFail(parseExportRequest(input)).message)).toStrictEqual(
      cases.map(({ message }) => message),
    );
  });
});

describe('parseExportArguments', () => {
  it('OPS-5 reads audit export --from --to [--format] from the command line', () => {
    const argv = ['audit', 'export', '--from', FROM, '--to', TO, '--format', 'csv'];
    expect(unwrapOk(parseExportArguments(argv))).toStrictEqual({ ...REQUEST, format: 'csv' });
  });

  it('refuses an unknown option, an unknown command and a bad window', () => {
    const unknownOption = unwrapFail(parseExportArguments(['audit', 'export', '--bogus']));
    const unknownCommand = unwrapFail(parseExportArguments(['audit', 'prune']));
    const badWindow = unwrapFail(
      parseExportArguments(['audit', 'export', '--from', TO, '--to', FROM]),
    );
    expect(unknownOption.message).toContain(
      "invalid arguments: TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--bogus'",
    );
    expect(unknownOption.cause).toBeInstanceOf(TypeError);
    expect(unknownCommand.message).toBe('unknown command: audit prune');
    expect(badWindow.message).toBe('from must be before to');
    expect(USAGE).toContain('audit export --from');
  });
});

describe('writeAuditExport', () => {
  it('OPS-5 streams the export and leaves the output open', async () => {
    expect(await collect(REQUEST, true)).toBe(
      '{"id":"id-1","at":"2026-09-22T12:00:00.000Z","category":"identity","action":"logout","outcome":"ok"}\n',
    );
    expect(await collect({ ...REQUEST, format: 'csv' }, true)).toMatch(
      /^id,at,category.*\r\n.*logout.*\r\n$/s,
    );
  });

  it('exports an absent store as empty: nothing, or the CSV header alone', async () => {
    expect(await collect(REQUEST, false)).toBe('');
    expect(await collect({ ...REQUEST, format: 'csv' }, false)).toBe(
      'id,at,category,action,outcome,operatorId,clientId,tokenPrefix,itemId,field,requestId,ip,durationMs,details\r\n',
    );
  });
});
