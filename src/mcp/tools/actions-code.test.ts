import { describe, expect, it } from 'vitest';

import { storedCalls } from '../../test-support/actions-fixtures.ts';
import { createCodeApp } from '../../test-support/code-app.ts';
import { createCodeTarget, OTHER_REPO, sidecarResult } from '../../test-support/code-connector.ts';
import {
  callTool,
  initializeRequest,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  postJsonRpc,
  request,
} from '../../test-support/mcp-client.ts';

import type { App } from '../../http/app.ts';

const MODERN = { protocolVersion: MODERN_PROTOCOL_VERSION } as const;

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  readonly annotations: Readonly<Record<string, unknown>>;
}

async function listTools(app: App, token: string): Promise<readonly ListedTool[]> {
  const response = await postJsonRpc(app, request('tools/list'), { token, ...MODERN });
  return (response.message as { result: { tools: ListedTool[] } }).result.tools;
}

async function instructionsFor(app: App, token: string): Promise<string> {
  const response = await postJsonRpc(app, initializeRequest(LEGACY_PROTOCOL_VERSION), {
    token,
    protocolVersion: LEGACY_PROTOCOL_VERSION,
  });
  return String((response.message as { result: { instructions: unknown } }).result.instructions);
}

describe('the code tools on the wire (ACT-15, ACT-110)', () => {
  it('ACT-15 ACT-18 ACT-110 registers the three code tools for actions:code, with repo in front and the read-only annotations', async () => {
    const { app, issue } = createCodeApp();
    const tools = await listTools(app, issue(['actions:code']));
    expect(tools.map((tool) => tool.name)).toStrictEqual([
      'actions_list_targets',
      'code_search',
      'code_find_related',
      'code_read',
    ]);
    const [, searchTool, , readTool] = tools;
    expect(Object.keys(searchTool?.inputSchema.properties ?? {})[0]).toBe('repo');
    expect(searchTool?.inputSchema.required).toStrictEqual(['repo', 'query']);
    expect(JSON.stringify(searchTool?.inputSchema.properties['repo'])).toContain('"maxItems":10');
    expect(JSON.stringify(readTool?.inputSchema.properties['repo'])).not.toContain('maxItems');
    expect(searchTool?.annotations).toStrictEqual({
      title: 'Search code',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // actions:http is not an enabled scope here, so that token sees no actions tool at all.
    expect(await listTools(app, issue(['actions:http']))).toStrictEqual([]);
  });

  it("ACT-17 14.8.6 the descriptions carry semble's guidance and say no credential is returned", async () => {
    const { app, issue } = createCodeApp();
    const [, searchTool, related, read] = await listTools(app, issue(['actions:code']));
    expect(searchTool?.description).toContain('Search once with a focused query');
    expect(searchTool?.description).toContain('go straight there');
    expect(related?.description).toContain('Use after code_search');
    expect(read?.description).toContain('start_line and end_line');
    for (const tool of [searchTool, related, read]) {
      expect(tool?.description).toContain('never contain a credential');
    }
  });

  it('ACT-110 a code_search over a list of repos reaches the engine as one call over each, one row each', async () => {
    const { app, issue, code } = createCodeApp({
      sidecar: { answer: () => [sidecarResult('widgets')] },
    });
    await createCodeTarget(code);
    await createCodeTarget(code, { name: 'gadgets', destination: { repository: OTHER_REPO } });
    const outcome = await callTool(
      app,
      'code_search',
      { repo: ['widgets', 'gadgets'], query: 'widgets' },
      { token: issue(['actions:code']), ...MODERN },
    );
    expect(outcome.isError).toBe(false);
    expect((outcome.structuredContent as { repos: unknown[] }).repos).toHaveLength(2);
    expect(storedCalls(code.harness.database).map((row) => row.targetName)).toStrictEqual([
      'widgets',
      'gadgets',
    ]);
  });

  it('ACT-110 refuses a repeated repo, an empty list and more than ten at the schema, and a list for code_read', async () => {
    const { app, issue, code } = createCodeApp();
    await createCodeTarget(code);
    const token = issue(['actions:code']);
    const attempts: [string, Record<string, unknown>][] = [
      ['code_search', { repo: ['widgets', 'widgets'], query: 'q' }],
      ['code_search', { repo: [], query: 'q' }],
      [
        'code_search',
        { repo: Array.from({ length: 11 }, (_value, index) => `r${String(index)}`), query: 'q' },
      ],
      ['code_read', { repo: ['widgets'], file_path: 'a.ts' }],
      ['code_search', { target: 'widgets', query: 'q' }],
    ];
    const refused = [];
    for (const [name, input] of attempts) {
      const outcome = await callTool(app, name, input, { token, ...MODERN });
      refused.push(outcome.isError);
    }
    expect(refused).toStrictEqual([true, true, true, true, true]);
    expect(storedCalls(code.harness.database)).toStrictEqual([]);
  });
});

describe('MCP-16 the handshake instructions for code (14.8.6)', () => {
  it("MCP-16 a token with actions:code is given semble's guidance after the actions instructions", async () => {
    const { app, issue } = createCodeApp();
    const instructions = await instructionsFor(app, issue(['actions:code']));
    expect(instructions).toContain('actions_list_targets');
    expect(instructions).toContain('call code_search once with a focused query');
    expect(instructions).toContain('max_snippet_lines: null');
    expect(instructions).toContain('code_find_related');
  });

  it('MCP-16 a token without actions:code, or a deployment whose code tools are off, gets no code guidance', async () => {
    const { app, issue } = createCodeApp();
    expect(await instructionsFor(app, issue(['actions:http']))).not.toContain('code_search');
    const off = createCodeApp({ sidecar: { protocol: 9 } });
    await off.code.settle();
    const instructions = await instructionsFor(off.app, off.issue(['actions:code']));
    expect(instructions).toContain('actions_list_targets');
    expect(instructions).not.toContain('code_search');
  });
});
