import { describe, expect, it } from 'vitest';

import { ACTIONS_OFF, actionsEnabled } from '../../test-support/actions-config.ts';
import { createEchoConnector } from '../../test-support/fake-connector.ts';

import { CONNECTOR_LOADERS, connectorRegistry, loadConnectors, schemasFor } from './registry.ts';

describe('connector registry', () => {
  it('ACT-73 loads the runtime of an enabled connector only, and nothing while the layer is off', async () => {
    const loaded: string[] = [];
    const loaders = {
      http: () => {
        loaded.push('http');
        return Promise.resolve(createEchoConnector());
      },
      sql: () => {
        loaded.push('sql');
        return Promise.resolve(createEchoConnector());
      },
    };
    const registry = await loadConnectors(actionsEnabled(['http', 'browser']), loaders);
    expect(registry.kinds).toStrictEqual(['http']);
    expect(loaded).toStrictEqual(['http']);
    expect(registry.get('http')?.kind).toBe('http');
    expect(registry.get('sql')).toBeUndefined();
    expect(registry.forTool('http_request')?.kind).toBe('http');
    expect(registry.forTool('sql_query')).toBeUndefined();
    const connectorOnly = { ...ACTIONS_OFF, connectors: { ...ACTIONS_OFF.connectors, http: true } };
    const withoutMaster = await loadConnectors(connectorOnly, loaders);
    expect(withoutMaster.kinds).toStrictEqual([]);
    expect(loaded).toStrictEqual(['http']);
  });

  it('ACT-73 ACT-72 loads the http, sql, ssh and winrm runtimes in production when their switches are on, and no other connector before its milestone', async () => {
    expect(Object.keys(CONNECTOR_LOADERS)).toStrictEqual(['http', 'sql', 'ssh', 'winrm']);
    const everything = actionsEnabled(['http', 'sql', 'ssh', 'winrm', 'browser']);
    const production = await loadConnectors(everything);
    expect(production.kinds).toStrictEqual(['http', 'sql', 'ssh', 'winrm']);
    expect(production.tools.map((tool) => tool.name)).toStrictEqual([
      'http_request',
      'sql_query',
      'sql_execute',
      'ssh_run',
      'winrm_run',
    ]);
    expect(production.forTool('http_request')?.kind).toBe('http');
    expect(production.forTool('sql_query')?.kind).toBe('sql');
    expect(production.forTool('sql_execute')?.kind).toBe('sql');
    expect(production.forTool('ssh_run')?.kind).toBe('ssh');
    expect(production.forTool('winrm_run')?.kind).toBe('winrm');
    const withoutHttp = await loadConnectors(actionsEnabled(['browser']));
    expect(withoutHttp.kinds).toStrictEqual([]);
  });

  it('ACT-88 builds the ssh and winrm runtimes with the deployment switch, so an any-command target refuses every call once it is off', async () => {
    const policy = { allowed_commands: [], any_command: true };
    const allowed = await loadConnectors(
      actionsEnabled(['ssh', 'winrm'], { allowAnyCommand: true }),
    );
    const refused = await loadConnectors(actionsEnabled(['ssh', 'winrm']));
    for (const kind of ['ssh', 'winrm'] as const) {
      const request = { tool: `${kind}_run`, destination: {}, credential: {}, policy };
      expect(allowed.get(kind)?.authorize(request, { command: 'uptime' })).toMatchObject({
        allowed: true,
      });
      expect(refused.get(kind)?.authorize(request, { command: 'uptime' })).toStrictEqual({
        allowed: false,
        reason: 'command',
      });
    }
  });

  it('14.1 knows the http, sql, ssh and winrm schemas in every build and no other connector before its milestone', () => {
    expect(schemasFor('http')?.kind).toBe('http');
    expect(schemasFor('sql')?.kind).toBe('sql');
    expect(schemasFor('ssh')?.kind).toBe('ssh');
    expect(schemasFor('winrm')?.kind).toBe('winrm');
    expect(schemasFor('browser')).toBeUndefined();
    expect(connectorRegistry([]).kinds).toStrictEqual([]);
  });
});
