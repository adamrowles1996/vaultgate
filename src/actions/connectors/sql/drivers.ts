/**
 * Reaching the two CommonJS driver packages from ESM (ACT-73, ACT-84).
 * Node's loader offers a named export only where `cjs-module-lexer` can see
 * the assignment: `pg` assigns its classes plainly, so `Client` is a named
 * export, while `mssql`'s entry re-exports another module and its namespace
 * is only `default`, `module.exports` and `valueHandler` — `ConnectionPool`
 * is not on it and destructuring it gives `undefined`. `module.exports` is
 * always reachable as `default`, so the rule is: the namespace when it
 * carries the class, otherwise `default`. It is checked at run time, so a
 * package that changes its export shape in a dependency bump fails here,
 * named, instead of at `new undefined(…)` on the first call.
 */
import { ActionError } from '../../errors.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasClass<Module extends object>(
  candidate: Module | Record<string, unknown>,
  className: string,
): candidate is Module {
  return typeof Object.getOwnPropertyDescriptor(candidate, className)?.value === 'function';
}

function defaultExportOf(module: object): Record<string, unknown> | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(module, 'default')?.value;
  return isRecord(value) ? value : undefined;
}

export function driverModule<Module extends object>(module: Module, className: string): Module {
  if (hasClass<Module>(module, className)) {
    return module;
  }
  const exported = defaultExportOf(module);
  if (exported !== undefined && hasClass<Module>(exported, className)) {
    return exported;
  }
  throw new ActionError('connector_fault', { reason: 'driver_export', name: className });
}
