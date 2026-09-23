import { describe, expect, it } from 'vitest';

import { ActionError } from '../../errors.ts';

import { driverModule } from './drivers.ts';

/**
 * The only tests in the suite that touch the real driver packages. Vitest
 * hands an externalised CommonJS dependency back through an interop proxy
 * whose property lookup falls through to `default` — which is exactly the
 * interop Node's ESM loader does not do, and why the shipped loader passed
 * every test and failed on every real call. `Object.keys` still reports the
 * true named exports, so spreading the namespace into a plain object gives
 * the namespace production actually sees. No connection is opened: the
 * lookup only reads a property.
 */
function asNodeSeesIt<Module extends object>(module: Module): Module {
  return { ...module };
}

function refusalOf(work: () => unknown): ActionError {
  try {
    work();
  } catch (error) {
    if (error instanceof ActionError) {
      return error;
    }
    throw error instanceof Error ? error : new Error('expected an action error');
  }
  throw new Error('expected the lookup to refuse');
}

describe('the CommonJS driver packages', () => {
  it('ACT-84 mssql offers ConnectionPool on its default export, not as a named export', async () => {
    const namespace = asNodeSeesIt(await import('mssql'));
    // cjs-module-lexer finds none of the classes in mssql's entry, so a
    // destructure straight off the namespace yields `undefined`.
    expect(Object.keys(namespace)).not.toContain('ConnectionPool');
    expect(driverModule(namespace, 'ConnectionPool').ConnectionPool).toBeTypeOf('function');
  });

  it('ACT-84 pg offers Client as a real named export', async () => {
    const namespace = asNodeSeesIt(await import('pg'));
    expect(Object.keys(namespace)).toContain('Client');
    expect(driverModule(namespace, 'Client').Client).toBeTypeOf('function');
  });

  it('ACT-84 a package carrying the class nowhere is connector_fault, not a later TypeError', () => {
    const failure = refusalOf(() => driverModule({ default: {} }, 'ConnectionPool'));
    expect(failure.code).toBe('connector_fault');
    expect(failure.detail).toStrictEqual({ reason: 'driver_export', name: 'ConnectionPool' });
  });

  it('ACT-84 a default export that is not an object is no fallback', () => {
    expect(refusalOf(() => driverModule({ default: 'not a module' }, 'Client')).code).toBe(
      'connector_fault',
    );
  });
});
