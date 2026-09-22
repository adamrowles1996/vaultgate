import { createHash } from 'node:crypto';

import { type Clock, MS_PER_MINUTE, type RandomSource } from './primitives.ts';

import type { Logger } from '../logger.ts';
import type { BootstrapTokensStore } from './repositories/bootstrap-tokens.ts';
import type { OperatorsStore } from './repositories/operators.ts';

const BOOTSTRAP_TOKEN_TTL_MS = 30 * MS_PER_MINUTE;
const TOKEN_BYTES = 32;

export interface BootstrapDependencies {
  readonly operators: OperatorsStore;
  readonly bootstrapTokens: BootstrapTokensStore;
  readonly publicUrl: string;
  readonly presetToken: string | undefined;
  readonly logger: Logger;
  readonly random: RandomSource;
  readonly clock: Clock;
}

export interface Bootstrap {
  /**
  Mints (or presets) the token when no operator exists and logs the setup URL once (ID-1, ID-2).
  */
  ensureToken(): void;
  isTokenUsable(token: string | undefined): boolean;
  consumeToken(token: string): boolean;
  hasOperator(): boolean;
}

export function hashBootstrapToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createBootstrap(dependencies: BootstrapDependencies): Bootstrap {
  const { operators, bootstrapTokens, publicUrl, presetToken, logger, random, clock } =
    dependencies;
  const minted = { done: false };
  return {
    ensureToken: () => {
      if (minted.done || operators.count() > 0) {
        return;
      }
      minted.done = true;
      const token = presetToken ?? random(TOKEN_BYTES).toString('base64url');
      bootstrapTokens.insert(hashBootstrapToken(token), clock() + BOOTSTRAP_TOKEN_TTL_MS);
      logger.info(`Open ${publicUrl}/setup?token=${token} to create the operator account`);
    },
    isTokenUsable: (token) =>
      token !== undefined && bootstrapTokens.isUsable(hashBootstrapToken(token), clock()),
    consumeToken: (token) => bootstrapTokens.consume(hashBootstrapToken(token), clock()),
    hasOperator: () => operators.count() > 0,
  };
}
