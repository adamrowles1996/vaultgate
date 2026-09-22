import { z } from 'zod';

import { all } from '../../storage/query.ts';

import type { Parameters } from '../../storage/query.ts';
import type { DatabaseSync } from 'node:sqlite';

const countSchema = z.object({ n: z.number().int() });

/**
The single `COUNT(*) AS n` row of an aggregate query; summing keeps the type honest without a fallback.
*/
export function countRows(database: DatabaseSync, sql: string, ...parameters: Parameters): number {
  return all(database, sql, countSchema, ...parameters).reduce((sum, row) => sum + row.n, 0);
}
