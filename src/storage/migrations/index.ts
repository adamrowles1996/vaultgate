import { initial } from './001-initial.ts';

import type { Migration } from './types.ts';

export { type Migration } from './types.ts';

/**
 * Every migration this build knows, ascending by version with no gaps.
 */
export const MIGRATIONS: readonly Migration[] = [initial];
