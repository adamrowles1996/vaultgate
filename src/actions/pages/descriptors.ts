/**
 * How a connector's target documents are edited on the account page (ACT-6):
 * a form is a list of field descriptors, one per document field, saying how
 * the field is rendered and read back (text, number, checkbox, select, one
 * pattern per line, a set of checkboxes). The zod schemas of the connector
 * remain the validation; a descriptor only says what a schema cannot: how to
 * draw the field and which ones a chosen mode uses. Adding a connector adds a
 * descriptor list to the registry in `forms.ts`, never a branch to the renderer.
 */
import type { ConnectorKind } from '../../config/actions.ts';

export type DocumentName = 'destination' | 'credential' | 'policy';

export interface Option {
  readonly value: string;
  readonly label: string;
}

interface FieldBase {
  readonly document: DocumentName;
  readonly name: string;
  readonly label: string;
  /**
  Shown under the field: the default, the ceiling, or when the field applies.
  */
  readonly help?: string;
  /**
  The field is read only when the named sibling holds one of these values (a credential mode's own fields).
  */
  readonly when?: { readonly field: string; readonly values: readonly string[] };
}

export type FieldDescriptor = FieldBase &
  (
    | { readonly kind: 'text'; readonly required?: boolean }
    | {
        readonly kind: 'number';
        readonly min: number;
        readonly max: number;
        readonly fallback: number;
      }
    | { readonly kind: 'boolean'; readonly fallback: boolean }
    | { readonly kind: 'select'; readonly options: readonly Option[]; readonly fallback: string }
    | { readonly kind: 'lines'; readonly fallback: readonly string[] }
    | {
        readonly kind: 'set';
        readonly options: readonly string[];
        readonly fallback: readonly string[];
      }
  );

export interface ConnectorForm {
  readonly kind: ConnectorKind;
  readonly fields: readonly FieldDescriptor[];
}

const KIB = 1024;
const MIB = KIB * KIB;

/**
The common policy fields of ACT-1 with the defaults and ceilings of §13.11, on every connector's form.
*/
export const COMMON_POLICY_FIELDS: readonly FieldDescriptor[] = [
  {
    document: 'policy',
    name: 'timeout_ms',
    label: 'Timeout (ms)',
    kind: 'number',
    min: 1000,
    max: 300_000,
    fallback: 30_000,
    help: 'Default 30 000, at most 300 000.',
  },
  {
    document: 'policy',
    name: 'max_output_bytes',
    label: 'Maximum output (bytes)',
    kind: 'number',
    min: KIB,
    max: MIB,
    fallback: 256 * KIB,
    help: 'Default 262 144 (256 KiB), at most 1 048 576 (1 MiB); longer output is truncated.',
  },
  {
    document: 'policy',
    name: 'rate_limit_per_minute',
    label: 'Calls per minute',
    kind: 'number',
    min: 1,
    max: 600,
    fallback: 60,
    help: 'Default 60, at most 600.',
  },
  {
    document: 'policy',
    name: 'confirm_writes',
    label: 'Ask a human to confirm every non-read call (MCP elicitation)',
    kind: 'boolean',
    fallback: true,
    help: 'On for a new target; a client without elicitation is then refused non-read calls.',
  },
];
