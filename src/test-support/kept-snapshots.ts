/**
 * The engine's kept snapshots (ACT-108) in memory, for a test that builds
 * the connector's services by hand rather than through the engine.
 */
import type { KeptSnapshot, KeptSnapshots } from '../actions/connectors/connector.ts';

export function memorySnapshots(
  initial: readonly KeptSnapshot[] = [],
): KeptSnapshots & { readonly rows: Map<string, KeptSnapshot> } {
  const rows = new Map(initial.map((snapshot) => [snapshot.targetId, snapshot]));
  return {
    rows,
    load: () => Array.from(rows.values(), (snapshot) => ({ ...snapshot })),
    keep(snapshot) {
      rows.set(snapshot.targetId, snapshot);
    },
    forget(targetId) {
      rows.delete(targetId);
    },
  };
}
