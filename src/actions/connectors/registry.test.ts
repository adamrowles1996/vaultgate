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
    const registry = await loadConnectors(actionsEnabled(['http', 'ssh']), loaders);
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

  it('ACT-73 ships no connector runtime yet, so production loads nothing', async () => {
    expect(CONNECTOR_LOADERS).toStrictEqual({});
    const everything = actionsEnabled(['http', 'sql', 'ssh', 'winrm', 'browser']);
    const production = await loadConnectors(everything);
    expect(production.kinds).toStrictEqual([]);
  });

  it('14.1 knows the http schemas in every build and no other connector before its milestone', () => {
    expect(schemasFor('http')?.kind).toBe('http');
    expect(schemasFor('sql')).toBeUndefined();
    expect(connectorRegistry([]).kinds).toStrictEqual([]);
  });
});
