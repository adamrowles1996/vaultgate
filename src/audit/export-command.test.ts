import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { run } from '../storage/query.ts';
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
const REQUEST: ExportRequest = {
  from: Date.parse(FROM),
  to: Date.parse(TO),
  format: 'jsonl',
  stream: 'audit',
};

const ACTION_CALL =
  'INSERT INTO action_calls (id, at, target_id, target_name, connector, revision, tool, ' +
  'client_id, token_prefix, operation, classification, arguments, arguments_truncated, ' +
  'output_bytes, output_truncated, duration_ms, outcome, elicitation, request_id, ip) VALUES ' +
  "('call-1', ?, 'target-1', 'api', 'http', 3, 'http_request', 'client', 'aabbccdd0011', 'read', " +
  "'GET', '{\"path\":\"/v1/me\"}', 0, 42, 0, 7, 'ok', 'not_required', 'req-1', '203.0.113.9')";

async function collect(request: ExportRequest, hasStore: boolean): Promise<string> {
  const database = openTestDatabase();
  new StoreAuditSink({
    database,
    logger: captureLogger().logger,
    now: () => Date.parse('2026-09-22T12:00:00Z'),
    newId: () => 'id-1',
  }).record({ category: 'identity', action: 'logout', outcome: 'ok' });
  run(database, ACTION_CALL, Date.parse('2026-09-22T12:00:00Z'));
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

  it('ACT-62 defaults the stream to audit and accepts actions', () => {
    expect(unwrapOk(parseExportRequest({ from: FROM, to: TO })).stream).toBe('audit');
    expect(unwrapOk(parseExportRequest({ from: FROM, to: TO, stream: 'actions' })).stream).toBe(
      'actions',
    );
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
      {
        input: { from: FROM, to: TO, stream: 'sessions' },
        message: 'stream must be audit or actions, not sessions',
      },
      {
        input: { from: FROM, to: TO, stream: 'constructor' },
        message: 'stream must be audit or actions, not constructor',
      },
    ];
    expect(cases.map(({ input }) => unwrapFail(parseExportRequest(input)).message)).toStrictEqual(
      cases.map(({ message }) => message),
    );
  });
});

describe('parseExportArguments', () => {
  it('OPS-5 ACT-62 reads audit export --from --to [--format] [--stream] from the command line', () => {
    const argv = ['audit', 'export', '--from', FROM, '--to', TO, '--format', 'csv'];
    expect(unwrapOk(parseExportArguments(argv))).toStrictEqual({ ...REQUEST, format: 'csv' });
    expect(unwrapOk(parseExportArguments([...argv, '--stream', 'actions']))).toStrictEqual({
      ...REQUEST,
      format: 'csv',
      stream: 'actions',
    });
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
    expect(USAGE).toContain('--stream audit|actions');
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

  it('ACT-62 streams the action_calls rows as the actions stream in both formats', async () => {
    const jsonl = await collect({ ...REQUEST, stream: 'actions' }, true);
    expect(JSON.parse(jsonl)).toStrictEqual({
      id: 'call-1',
      at: '2026-09-22T12:00:00.000Z',
      targetId: 'target-1',
      targetName: 'api',
      connector: 'http',
      revision: 3,
      tool: 'http_request',
      clientId: 'client',
      tokenPrefix: 'aabbccdd0011',
      operation: 'read',
      classification: 'GET',
      arguments: '{"path":"/v1/me"}',
      argumentsTruncated: false,
      outputBytes: 42,
      outputTruncated: false,
      durationMs: 7,
      outcome: 'ok',
      elicitation: 'not_required',
      requestId: 'req-1',
      ip: '203.0.113.9',
    });
    expect(jsonl.endsWith('\n')).toBe(true);
    const csv = await collect({ ...REQUEST, stream: 'actions', format: 'csv' }, true);
    expect(csv.split('\r\n')).toStrictEqual([
      'id,at,targetId,targetName,connector,revision,tool,sessionIdHash,clientId,tokenPrefix,operation,classification,arguments,argumentsTruncated,outputBytes,outputTruncated,durationMs,outcome,elicitation,confirmationNonce,requestId,ip',
      'call-1,2026-09-22T12:00:00.000Z,target-1,api,http,3,http_request,,client,aabbccdd0011,read,GET,"{""path"":""/v1/me""}",false,42,false,7,ok,not_required,,req-1,203.0.113.9',
      '',
    ]);
  });

  it('exports an absent store as empty: nothing, or the CSV header alone', async () => {
    expect(await collect(REQUEST, false)).toBe('');
    expect(await collect({ ...REQUEST, format: 'csv' }, false)).toBe(
      'id,at,category,action,outcome,operatorId,clientId,tokenPrefix,itemId,field,requestId,ip,durationMs,details\r\n',
    );
    expect(await collect({ ...REQUEST, stream: 'actions' }, false)).toBe('');
    expect(await collect({ ...REQUEST, stream: 'actions', format: 'csv' }, false)).toMatch(
      /^id,at,targetId,.*,ip\r\n$/,
    );
  });
});
