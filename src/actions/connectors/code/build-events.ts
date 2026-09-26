/**
 * The audit events of builds (ACT-116): one per build, `actions.code_index_built`
 * or `actions.code_index_failed`, with the target, the commit, the content
 * selection, the trigger, the counts or the reason, and the duration; and one
 * for a build that could not start. Never a file name, a ref or content.
 */
import type { BuildOutcome, BuildRequest, Trigger } from './builds.ts';
import type { ConnectorServices } from '../connector.ts';

type Audit = Pick<ConnectorServices, 'audit'>;

/**
A build that never started: which target, why, and what started it.
*/
export interface Refusal {
  readonly targetId: string;
  readonly targetName: string;
  readonly trigger: Trigger;
  readonly content: readonly string[];
  readonly reason: string;
}

function counts(outcome: BuildOutcome): Readonly<Record<string, number | string>> {
  if (!outcome.ok) {
    return { reason: outcome.reason };
  }
  const { files, skipped, variants } = outcome.meta;
  return {
    files,
    chunks: Object.values(variants).reduce((sum, variant) => sum + variant.chunks, 0),
    skipped: skipped.links + skipped.special + skipped.excluded + skipped.large,
  };
}

/**
ACT-116: one event per build, with the counts or the reason; never a file name, a ref or content.
*/
export function recordBuild(
  services: Audit,
  request: BuildRequest,
  outcome: BuildOutcome,
  durationMs: number,
): void {
  services.audit.record({
    category: 'actions',
    action: outcome.ok ? 'code_index_built' : 'code_index_failed',
    outcome: outcome.ok ? 'ok' : `error:${outcome.reason}`,
    durationMs,
    details: {
      target: request.targetName,
      connector: 'code',
      commit: request.commit,
      trigger: request.trigger,
      content: request.variants.map((variant) => variant.join('+')),
      ...counts(outcome),
    },
  });
}

/**
A build that never started, in the audit trail.
*/
export function recordRefusal(services: Audit, refusal: Refusal): void {
  services.audit.record({
    category: 'actions',
    action: 'code_index_failed',
    outcome: `error:${refusal.reason}`,
    durationMs: 0,
    details: {
      target: refusal.targetName,
      connector: 'code',
      trigger: refusal.trigger,
      content: refusal.content.length > 0 ? [refusal.content.join('+')] : [],
      reason: refusal.reason,
    },
  });
}
