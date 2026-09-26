/**
 * What the engine lends a stateful connector (ACT-108, ACT-109): a target's
 * credential and pinned endpoints for work no call started (a build on save
 * or on Rebuild index), fetched and pinned exactly as a call's are (ACT-50,
 * ACT-54 to ACT-56) and zeroed when the work ends; the stored targets of the
 * connector, for reconciliation; and the snapshot each target's calls answer
 * from, kept across a restart. The connector never reaches the vault, the
 * resolver or the store itself. A disabled target lends nothing: its
 * credential is never used by a build nobody could call.
 */
import { fail, ok } from '../result.ts';

import { fetchCredential, pinDestination } from './engine-run.ts';
import { ActionError } from './errors.ts';
import { keptSnapshots } from './kept-snapshots.ts';
import { createRunSupport } from './run-support.ts';
import { validateTarget } from './targets-schemas.ts';

import type { ConnectorServices, StoredTarget } from './connectors/connector.ts';
import type { EngineContext } from './engine-context.ts';
import type { ConnectorKind } from '../config/actions.ts';

export function connectorServices(context: EngineContext, kind: ConnectorKind): ConnectorServices {
  return {
    logger: context.logger,
    now: context.now,
    schedule: context.schedule,
    audit: context.audit,
    async withTarget(targetId, work) {
      const row = context.repo.findById(targetId);
      if (row?.connector !== kind) {
        return fail(new ActionError('unknown_target'));
      }
      if (!row.enabled) {
        return fail(new ActionError('target_disabled'));
      }
      const target = validateTarget(row);
      if (target.state === 'invalid') {
        return fail(new ActionError('target_invalid'));
      }
      const credential = await fetchCredential(context, { target });
      if (!credential.ok) {
        return credential;
      }
      try {
        const pinned = await pinDestination(context.lookup, { target });
        if (!pinned.ok) {
          return pinned;
        }
        const support = createRunSupport(context, row, credential.value);
        return ok(
          await work({
            ...target.documents,
            injected: credential.value.injected,
            support,
            pinned: pinned.value,
            logger: context.logger,
          }),
        );
      } finally {
        credential.value.injected.dispose();
      }
    },
    snapshots: keptSnapshots(context.database, context.logger),
    targets(): readonly StoredTarget[] {
      return context.repo
        .list()
        .filter((row) => row.connector === kind)
        .map((row) => {
          const target = validateTarget(row);
          return {
            id: row.id,
            name: row.name,
            enabled: row.enabled,
            documents: target.state === 'valid' ? target.documents : undefined,
          };
        });
    },
  };
}
