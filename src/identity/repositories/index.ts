import { createBootstrapTokensStore } from './bootstrap-tokens.ts';
import { createLoginAttemptsStore } from './login-attempts.ts';
import { createOperatorsStore } from './operators.ts';
import { createRecoveryCodesStore } from './recovery-codes.ts';
import { createSessionsStore } from './sessions.ts';

import type { BootstrapTokensStore } from './bootstrap-tokens.ts';
import type { LoginAttemptsStore } from './login-attempts.ts';
import type { OperatorsStore } from './operators.ts';
import type { RecoveryCodesStore } from './recovery-codes.ts';
import type { SessionsStore } from './sessions.ts';
import type { DatabaseSync } from 'node:sqlite';

export type { OperatorRecord } from './operators.ts';
export type { SessionRecord } from './sessions.ts';

export interface IdentityStores {
  readonly operators: OperatorsStore;
  readonly recoveryCodes: RecoveryCodesStore;
  readonly bootstrapTokens: BootstrapTokensStore;
  readonly sessions: SessionsStore;
  readonly loginAttempts: LoginAttemptsStore;
}

export function createIdentityStores(database: DatabaseSync): IdentityStores {
  return {
    operators: createOperatorsStore(database),
    recoveryCodes: createRecoveryCodesStore(database),
    bootstrapTokens: createBootstrapTokensStore(database),
    sessions: createSessionsStore(database),
    loginAttempts: createLoginAttemptsStore(database),
  };
}
