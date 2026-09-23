import { describe, expect, it } from 'vitest';

import { SCOPES } from '../../scopes/registry.ts';
import { callTool } from '../../test-support/mcp-client.ts';
import { createTestApp } from '../../test-support/test-app.ts';
import { CANARIES, CANARY } from '../../test-support/vault-fixture.ts';
import { TOOL_NAMES } from '../scopes.ts';

/**
Arguments that make every tool touch the canary items.
*/
const CALLS: Readonly<Record<string, unknown>> = {
  vault_status: {},
  search_items: { include_trash: true },
  get_item: { item_id: 'item-login' },
  list_folders: {},
  list_collections: {},
  get_secret: { item_id: 'item-login', field: 'password' },
  generate_password: {},
  generate_passphrase: {},
  create_item: { type: 'login', name: 'Fresh', generate_password: true },
  update_item: { item_id: 'item-login', name: 'Renamed', generate_password: true },
  trash_item: { item_id: 'item-note' },
  create_folder: { name: 'Fresh folder' },
};

const NON_SECRET_TOOLS = TOOL_NAMES.filter((name) => name !== 'get_secret');

describe('MCP-9 secret containment', () => {
  it('covers every tool in the specification', () => {
    expect(Object.keys(CALLS).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      TOOL_NAMES.toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it.each(NON_SECRET_TOOLS)(
    'MCP-9 %s yields no canary anywhere in the HTTP response',
    async (name) => {
      const { app, verifier } = createTestApp();
      const token = verifier.issue({ scopes: [...SCOPES] });
      const outcome = await callTool(app, name, CALLS[name], { token });
      expect(outcome.status).toBe(200);
      expect(outcome.isError).toBe(false);
      expect(CANARIES.filter((canary) => outcome.text.includes(canary))).toStrictEqual([]);
    },
  );

  it('MCP-9 get_secret is the positive control: the canary does come back', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: [...SCOPES] });
    const outcome = await callTool(app, 'get_secret', CALLS['get_secret'], { token });
    expect(outcome.structuredContent).toStrictEqual({ kind: 'text', value: CANARY.password });
  });

  it('MCP-12 notes are reachable only through get_secret', async () => {
    const { app, verifier } = createTestApp();
    const token = verifier.issue({ scopes: [...SCOPES] });
    const item = await callTool(app, 'get_item', { item_id: 'item-note' }, { token });
    expect(item.text).not.toContain(CANARY.secureNote);
    const note = await callTool(
      app,
      'get_secret',
      { item_id: 'item-note', field: 'notes' },
      { token },
    );
    expect(note.structuredContent).toStrictEqual({ kind: 'text', value: CANARY.secureNote });
  });

  it('MCP-9 the tools/list advertisement carries no canary either', async () => {
    const { app, verifier, logged } = createTestApp();
    const token = verifier.issue({ scopes: [...SCOPES] });
    await Promise.all(NON_SECRET_TOOLS.map((name) => callTool(app, name, CALLS[name], { token })));
    expect(CANARIES.filter((canary) => logged().includes(canary))).toStrictEqual([]);
  });
});
