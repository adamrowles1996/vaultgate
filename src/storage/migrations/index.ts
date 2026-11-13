import { initial } from './001-initial.ts';
import { operatorEmail } from './002-operator-email.ts';
import { vaultSettings } from './003-vault-settings.ts';
import { actions } from './004-actions.ts';
import { codeConnector } from './005-code-connector.ts';
import { readOnlyGrants } from './006-read-only-grants.ts';
import { callerTag } from './007-caller-tag.ts';

import type { Migration } from './types.ts';

export { type Migration } from './types.ts';

/**
 * Every migration this build knows, ascending by version with no gaps.
 */
export const MIGRATIONS: readonly Migration[] = [
  initial,
  operatorEmail,
  vaultSettings,
  actions,
  codeConnector,
  readOnlyGrants,
  callerTag,
];
