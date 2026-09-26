/**
 * `code_read` (ACT-110, ACT-111): lines of one file of the call's snapshot,
 * at most `max_read_lines`. A search over several repositories gives every
 * `file_path` as `<connection>/<path>`, as `semble` prefixes merged results;
 * so that a read can follow such a result, a path the snapshot does not hold
 * as given is tried once more without its own connection's prefix. The text
 * goes back as a captured value, which the engine scrubs and cuts (ACT-51,
 * ACT-52).
 */
import { ok } from '../../../result.ts';

import { SidecarRefusal } from './sidecar.ts';

import type { ConnectorOutput } from '../connector.ts';
import type { Prepared } from './indexes.ts';
import type { SidecarRead } from './sidecar-schemas.ts';
import type { SidecarClient, SidecarOutcome } from './sidecar.ts';
import type { ReadOperation } from './tools.ts';

export interface ReadRequest {
  readonly prepared: Prepared;
  readonly operation: ReadOperation;
  readonly maxLines: number;
  readonly signal: AbortSignal;
}

function isPathNotFound(outcome: SidecarOutcome<SidecarRead>): boolean {
  return (
    !outcome.ok &&
    outcome.error instanceof SidecarRefusal &&
    outcome.error.code === 'path_not_found'
  );
}

export async function readFile(
  sidecar: SidecarClient,
  request: ReadRequest,
): Promise<SidecarOutcome<ConnectorOutput>> {
  const { prepared, operation, signal } = request;
  const read = (path: string): Promise<SidecarOutcome<SidecarRead>> =>
    sidecar.read(
      {
        key: prepared.key,
        file_path: path,
        start_line: operation.start_line,
        end_line: operation.end_line,
        max_lines: request.maxLines,
      },
      signal,
    );
  const prefix = `${prepared.label}/`;
  const asGiven = await read(operation.file_path);
  // ACT-111: the path's rules leave something after the prefix, never an empty path.
  const found =
    isPathNotFound(asGiven) && operation.file_path.startsWith(prefix)
      ? await read(operation.file_path.slice(prefix.length))
      : asGiven;
  if (!found.ok) {
    return found;
  }
  const { file_path, start_line, end_line, total_lines, truncated, text } = found.value;
  return ok({
    result: {
      repo: prepared.label,
      commit: prepared.commit,
      file_path,
      start_line,
      end_line,
      total_lines,
      truncated,
    },
    captured: { text: Buffer.from(text, 'utf8') },
  });
}
