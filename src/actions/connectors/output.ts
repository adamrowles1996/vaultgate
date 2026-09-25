/**
 * What a connector hands the engine: the description of an operation for the
 * audit trail and the confirmation (ACT-43, ACT-60) and the raw output of a
 * run, which the engine scrubs and cuts (ACT-51, ACT-52). Re-exported by
 * `./connector.ts`.
 */
import type { OmittedText } from './operation-summary.ts';

export interface OperationDescription {
  /**
  ACT-43: the method and path, the statement or command, or the page URL and element; an excerpt when it is long.
  */
  readonly summary: string;
  /**
  ACT-43: what the excerpt leaves out, when it is one; the confirmation message says so where the agent cannot forge it.
  */
  readonly omitted?: OmittedText;
  /**
  ACT-60: the SQL class, the HTTP method, `command`, or the browser page URL.
  */
  readonly classification: string;
}

export interface ConnectorOutput {
  /**
  The tool result before scrubbing; every string inside is scrubbed by the engine.
  */
  readonly result: Readonly<Record<string, unknown>>;
  /**
  Byte streams captured up to `maxBytes + guardBytes` (`body`, `stdout`, `stderr`, `snapshot`); the
  engine scrubs and cuts each and writes the text into `result` under the same key.
  */
  readonly captured: Readonly<Record<string, Buffer>>;
  /**
   * ACT-51, ACT-52: the `captured` keys the engine returns base64-encoded. A
   * connector hands over the raw bytes and names the key here; it never encodes
   * them itself, because base64 is positional and the scrub table holds the
   * value's own encodings, not the encoding of a buffer that contains it.
   */
  readonly base64?: readonly string[];
  /**
  ACT-60: the size of a result that is not a byte stream (the `sql` rows), for `output_bytes`;
  without it the engine adds up what `captured` holds.
  */
  readonly bytes?: number;
}
