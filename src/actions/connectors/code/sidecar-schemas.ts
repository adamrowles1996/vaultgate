/**
 * The code sidecar's protocol version 1 (`sidecars/code/PROTOCOL.md`) as zod
 * schemas: every response vaultgate reads is validated here before anything
 * uses it (ACT-113), so a sidecar that answers out of shape is a fault, not a
 * value that flows on to an agent.
 */
import { z } from 'zod';

import type { CONTENT_TYPES } from './schemas.ts';

export const SIDECAR_PROTOCOL = 1;

const count = z.number().int().nonnegative();

export const healthSchema = z.looseObject({
  protocol: z.number().int(),
  semble: z.string(),
  model: z.string(),
  model_revision: z.string(),
});

export type SidecarHealth = z.output<typeof healthSchema>;

const variantMetaSchema = z.looseObject({
  files: count,
  chunks: count,
  built_at: z.number(),
  duration_ms: count,
});

const skippedSchema = z.looseObject({
  links: count,
  special: count,
  excluded: count,
  large: count,
});

export const snapshotMetaSchema = z.looseObject({
  key: z.string(),
  owner: z.string(),
  commit: z.string(),
  created_at: z.number(),
  last_used_at: z.number(),
  files: count,
  bytes: count,
  skipped: skippedSchema,
  storage_bytes: count,
  variants: z.record(z.string(), variantMetaSchema),
});

export type SnapshotMeta = z.output<typeof snapshotMetaSchema>;

export const buildingSchema = z.looseObject({
  state: z.literal('building'),
  started_at: z.number(),
});

const buildingEntrySchema = z.looseObject({
  key: z.string(),
  owner: z.string(),
  started_at: z.number(),
});

export const snapshotListSchema = z.looseObject({
  snapshots: z.array(snapshotMetaSchema),
  building: z.array(buildingEntrySchema),
});

export type SnapshotList = z.output<typeof snapshotListSchema>;

export const deletedSchema = z.looseObject({ deleted: count });

const resultSchema = z.looseObject({
  label: z.string(),
  file_path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  score: z.number(),
  language: z.string().nullable().optional(),
  content: z.string().optional(),
});

export type SidecarResult = z.output<typeof resultSchema>;

export const resultsSchema = z.looseObject({ results: z.array(resultSchema) });

export const readSchema = z.looseObject({
  file_path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  total_lines: count,
  text: z.string(),
  truncated: z.boolean(),
});

export type SidecarRead = z.output<typeof readSchema>;

export const errorSchema = z.looseObject({
  error: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

/**
The build spec vaultgate sends with an archive (`X-Vaultgate-Build`).
*/
export interface BuildSpec {
  readonly owner: string;
  readonly commit: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly max_archive_bytes: number;
  readonly max_files: number;
  readonly max_total_bytes: number;
  readonly max_file_bytes: number;
  readonly build_timeout_s: number;
  readonly variants: readonly (readonly (typeof CONTENT_TYPES)[number][])[];
}

/**
One index a search or related query reads: a snapshot and the label its results carry.
*/
export interface IndexReference {
  readonly key: string;
  readonly label: string;
}
