import { describe, expect, it } from 'vitest';

import { ACTION_ERROR_MESSAGES } from '../../actions/errors.ts';
import {
  type ActionsApp,
  connectLegacySdkClient,
  connectSdkClient,
  createActionsApp,
  rawCall,
  requestStateOf,
  retryParameters,
  scriptedElicitation,
} from '../../test-support/actions-app.ts';
import { createHttpTarget, OPERATOR_ID, storedCalls } from '../../test-support/actions-fixtures.ts';
import { CANARY } from '../../test-support/vault-fixture.ts';
import { VaultError } from '../../vault/client.ts';

import type { ElicitResult } from '@modelcontextprotocol/client';

const POST = { target: 'api', method: 'POST', path: '/v1/items', body: '{"name":"x"}' };
const ACCEPT: ElicitResult = { action: 'accept', content: { confirm: true } };
const HTTP = ['actions:http'];

async function confirmedApp(): Promise<ActionsApp & { readonly token: string }> {
  const fixture = createActionsApp();
  await createHttpTarget(fixture.harness, {
    policy: { allowed_methods: ['GET', 'POST'], confirm_writes: true },
  });
  return { ...fixture, token: fixture.issue(HTTP) };
}

describe('confirmation through the MCP client SDK (2026-07-28)', () => {
  it('ACT-76 ACT-41 ACT-42 ACT-45 ACT-47 shows the client the ACT-42 document, runs the call once the human accepts, and records the accepted elicitation', async () => {
    const { app, token, harness, audit } = await confirmedApp();
    const script = scriptedElicitation([ACCEPT]);
    const client = await connectSdkClient(app, { token, elicitation: script.handler });
    const result = await client.callTool({ name: 'http_request', arguments: POST });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 200, truncated: false });
    expect(script.shown).toHaveLength(1);
    expect(script.shown[0]?.params).toMatchObject({
      mode: 'form',
      message: expect.stringContaining('POST /v1/items') as string,
      requestedSchema: { required: ['confirm'] },
    });
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'ok', elicitation: 'accepted', operation: 'write' },
    ]);
    expect(audit.events.filter((event) => event.category === 'mcp')).toHaveLength(1);
    await client.close();
  });

  it('ACT-76 ACT-47 declines on accept without confirm, on decline, and cancels on cancel, none of them running', async () => {
    const { app, token, harness } = await confirmedApp();
    const answers: readonly [ElicitResult, string][] = [
      [{ action: 'accept', content: { confirm: false } }, 'confirmation_declined'],
      [{ action: 'accept' }, 'confirmation_declined'],
      [{ action: 'decline' }, 'confirmation_declined'],
      [{ action: 'cancel' }, 'confirmation_cancelled'],
    ];
    const script = scriptedElicitation(answers.map(([answer]) => answer));
    const client = await connectSdkClient(app, { token, elicitation: script.handler });
    for (const [, code] of answers) {
      const result = await client.callTool({ name: 'http_request', arguments: POST });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toStrictEqual({
        error: code,
        message: ACTION_ERROR_MESSAGES[code as keyof typeof ACTION_ERROR_MESSAGES],
      });
    }
    expect(storedCalls(harness.database).map((call) => call.elicitation)).toStrictEqual([
      'declined',
      'declined',
      'declined',
      'cancelled',
    ]);
    expect(harness.connector.contexts).toStrictEqual([]);
    await client.close();
  });

  it('ACT-76 ACT-48 refuses a client that declares no elicitation before touching the vault or the network', async () => {
    const { app, token, harness } = await confirmedApp();
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    harness.lookups.length = 0;
    const client = await connectSdkClient(app, { token, elicitation: 'none' });
    const result = await client.callTool({ name: 'http_request', arguments: POST });
    expect(result.structuredContent).toStrictEqual({
      error: 'confirmation_unavailable',
      message:
        'this target requires a human confirmation and your client does not support MCP ' +
        'elicitation; ask the operator to use a client that does, or to lift the requirement for ' +
        'this target',
    });
    expect(harness.lookups).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:confirmation_unavailable', elicitation: 'unavailable' },
    ]);
    const read = await client.callTool({
      name: 'http_request',
      arguments: { target: 'api', method: 'GET', path: '/v1/me' },
    });
    expect(read.structuredContent).toMatchObject({ error: 'credential_unavailable' });
    await client.close();
  });

  it('MCP-7 a vault:read-only token sees no actions tool through the SDK, an actions token sees both', async () => {
    const { app, issue } = createActionsApp();
    const readOnly = await connectSdkClient(app, {
      token: issue(['vault:read']),
      elicitation: 'none',
    });
    const listed = await readOnly.listTools();
    expect(listed.tools.map((tool) => tool.name)).not.toContain('actions_list_targets');
    expect(listed.tools.map((tool) => tool.name)).not.toContain('http_request');
    await readOnly.close();
    const actions = await connectSdkClient(app, { token: issue(HTTP), elicitation: 'none' });
    const listedForActions = await actions.listTools();
    expect(listedForActions.tools.map((tool) => tool.name)).toStrictEqual([
      'actions_list_targets',
      'http_request',
    ]);
    const targets = await actions.callTool({ name: 'actions_list_targets', arguments: {} });
    expect(targets.structuredContent).toStrictEqual({ targets: [] });
    await actions.close();
  });
});

describe('retried confirmations on the wire', () => {
  it('ACT-46 ACT-76 runs an accepted retry once and refuses its replay as confirmation_reused', async () => {
    const { app, token, harness } = await confirmedApp();
    const first = await rawCall(app, { token }, { name: 'http_request', arguments: POST });
    const retry = { requestState: requestStateOf(first), answer: ACCEPT };
    const ran = await rawCall(app, { token }, retryParameters('http_request', POST, retry));
    expect(ran['structuredContent']).toMatchObject({ status: 200 });
    const replayed = await rawCall(app, { token }, retryParameters('http_request', POST, retry));
    expect(replayed['structuredContent']).toStrictEqual({
      error: 'confirmation_reused',
      message: ACTION_ERROR_MESSAGES.confirmation_reused,
    });
    expect(storedCalls(harness.database).map((call) => call.elicitation)).toStrictEqual([
      'accepted',
      'invalid',
    ]);
  });

  it('ACT-45 ACT-76 refuses an expired state, altered arguments, an edited target and another token', async () => {
    const { app, token, issue, harness } = await confirmedApp();
    const pending = await rawCall(app, { token }, { name: 'http_request', arguments: POST });
    const retry = { requestState: requestStateOf(pending), answer: ACCEPT };
    const altered = await rawCall(
      app,
      { token },
      retryParameters('http_request', { ...POST, body: '{"name":"y"}' }, retry),
    );
    expect(altered['structuredContent']).toMatchObject({ error: 'confirmation_invalid' });
    const otherToken = await rawCall(
      app,
      { token: issue(HTTP) },
      retryParameters('http_request', POST, retry),
    );
    expect(otherToken['structuredContent']).toMatchObject({ error: 'confirmation_invalid' });
    const target = harness.engine.targets.list()[0];
    harness.engine.targets.setEnabled(target?.id ?? '', true, OPERATOR_ID);
    const edited = await rawCall(app, { token }, retryParameters('http_request', POST, retry));
    expect(edited['structuredContent']).toMatchObject({ error: 'confirmation_invalid' });
    const fresh = await rawCall(app, { token }, { name: 'http_request', arguments: POST });
    await harness.clock.advance(120_000);
    const expired = await rawCall(
      app,
      { token },
      retryParameters('http_request', POST, {
        requestState: requestStateOf(fresh),
        answer: ACCEPT,
      }),
    );
    expect(expired['structuredContent']).toStrictEqual({
      error: 'confirmation_expired',
      message: ACTION_ERROR_MESSAGES.confirmation_expired,
    });
    expect(storedCalls(harness.database).map((call) => call.outcome)).toStrictEqual([
      'denied:confirmation_invalid',
      'denied:confirmation_invalid',
      'denied:confirmation_invalid',
      'denied:confirmation_expired',
    ]);
    expect(harness.connector.contexts).toStrictEqual([]);
  });
});

describe('canaries on the wire', () => {
  const USERNAME = 'alice@example.com';

  function variantsOf(value: string): readonly string[] {
    return [
      value,
      encodeURIComponent(value),
      new URLSearchParams([['v', value]]).toString().slice(2),
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('base64url'),
      Buffer.from(`${USERNAME}:${value}`).toString('base64'),
      JSON.stringify(value).slice(1, -1),
    ];
  }

  it('ACT-53 no variant of the injected value reaches a tool result, an elicitation message, an audit row or a log line when the destination echoes it', async () => {
    const { app, token, harness, audit, logged } = await confirmedApp();
    const script = scriptedElicitation([ACCEPT]);
    const client = await connectSdkClient(app, { token, elicitation: script.handler });
    const written = await client.callTool({ name: 'http_request', arguments: POST });
    const read = await client.callTool({
      name: 'http_request',
      arguments: { target: 'api', method: 'GET', path: '/v1/me?q=x' },
    });
    await client.close();
    expect(written.isError).toBeFalsy();
    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read.structuredContent)).toContain('[redacted:password]');
    const surfaces = [
      JSON.stringify(written),
      JSON.stringify(read),
      JSON.stringify(script.shown),
      JSON.stringify(audit.events),
      JSON.stringify(storedCalls(harness.database)),
      logged(),
      JSON.stringify(harness.logged()),
    ].join('\n');
    const leaked = variantsOf(CANARY.password).filter((variant) => surfaces.includes(variant));
    expect(leaked).toStrictEqual([]);
  });
});

/**
 * ACT-48, ACT-76 second behaviour. The 2025 wire declares elicitation once, at
 * `initialize`; the stateless handler of MCP-1 builds a fresh server per HTTP
 * request and never sees that message, so the declaration cannot reach the
 * call. These tests pin what actually happens rather than what the earlier
 * wording hoped for.
 */
describe('a client on the 2025 wire (ACT-48)', () => {
  it('ACT-76 ACT-48 is refused a confirmed target with confirmation_unavailable even though it declared form elicitation at initialize', async () => {
    const { app, token, harness } = await confirmedApp();
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    harness.lookups.length = 0;
    const script = scriptedElicitation([ACCEPT]);
    const client = await connectLegacySdkClient(app, { token, elicitation: script.handler });
    const result = await client.callTool({ name: 'http_request', arguments: POST });
    expect(result.structuredContent).toStrictEqual({
      error: 'confirmation_unavailable',
      message: ACTION_ERROR_MESSAGES.confirmation_unavailable,
    });
    // The client offered to show a prompt and was never asked to.
    expect(script.shown).toStrictEqual([]);
    expect(harness.lookups).toStrictEqual([]);
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'denied:confirmation_unavailable', elicitation: 'unavailable' },
    ]);
    await client.close();
  });

  it('ACT-76 ACT-48 serves a read on the same target and the same wire, so only the confirmation is out of reach', async () => {
    const { app, token, harness } = await confirmedApp();
    const client = await connectLegacySdkClient(app, { token, elicitation: 'none' });
    const read = await client.callTool({
      name: 'http_request',
      arguments: { target: 'api', method: 'GET', path: '/v1/me' },
    });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ status: 200 });
    expect(storedCalls(harness.database)).toMatchObject([
      { outcome: 'ok', elicitation: 'not_required', operation: 'read' },
    ]);
    await client.close();
  });
});
