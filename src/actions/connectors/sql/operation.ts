/**
 * `sql_query` as the connector declares it (spec §13.6.4): the operation
 * arguments the engine parses (ACT-23), the strict result (ACT-24), the
 * LLM-facing description (ACT-17) and the annotations of the 13.6.1 row
 * (ACT-18). The MCP layer puts `target` in front of the arguments.
 */
import { z } from 'zod';

import type { OutputSchema } from '../../../mcp/tools/definition.ts';
import type { ConnectorTool } from '../connector.ts';

const MAX_STATEMENT_BYTES = 64 * 1024;
const MAX_PARAMETERS = 100;

export const sqlScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const statementSchema = z
  .string()
  .min(1)
  .superRefine((statement, context) => {
    if (Buffer.byteLength(statement, 'utf8') > MAX_STATEMENT_BYTES) {
      context.addIssue({ code: 'custom', message: 'must be at most 64 KiB' });
    }
  })
  .describe(
    'Exactly one SQL statement. Values go in params, never in the text: there is no ' +
      'interpolation path. Anything after a statement separator is refused.',
  );

const parametersSchema = z
  .array(sqlScalarSchema)
  .max(MAX_PARAMETERS)
  .default([])
  .describe(
    'The values bound to the statement placeholders, positionally: $1…$n on PostgreSQL and ' +
      '@p1…@pn on SQL Server. At most 100 strings, numbers, booleans or nulls.',
  );

export const sqlQuerySchema = z.strictObject({
  statement: statementSchema,
  params: parametersSchema,
});

export type SqlOperation = z.output<typeof sqlQuerySchema>;

const columnSchema = z.strictObject({ name: z.string(), type: z.string() });

export const sqlQueryOutputSchema: OutputSchema = z.strictObject({
  columns: z
    .array(columnSchema)
    .describe('The result columns in order, each with the name and the engine type name.'),
  rows: z
    .array(z.array(sqlScalarSchema))
    .describe(
      'The rows, each an array of values in column order. Dates are ISO 8601 strings, binary ' +
        'is base64, decimals and 64-bit integers are strings.',
    ),
  row_count: z.number().int().describe('The number of rows returned.'),
  truncated: z
    .boolean()
    .describe('True when rows beyond the target row or output limit were dropped.'),
  duration_ms: z.number().int(),
});

export const SQL_QUERY_DESCRIPTION =
  'Runs one read-only SQL statement against a database the operator configured, signed in with a ' +
  'credential from the vault that you never see. `target` must be a name returned by ' +
  'actions_list_targets, and its `engine` there tells you which dialect and which placeholders to ' +
  'write. `statement` must be exactly one statement whose first keyword is SELECT, WITH or ' +
  'EXPLAIN and which contains no writing, executing or session-changing keyword outside a string ' +
  'or a comment; anything else is refused with policy_denied before any connection is opened. ' +
  'Put every value in `params` and reference them positionally as $1…$n (PostgreSQL) or ' +
  '@p1…@pn (SQL Server); a placeholder without a parameter, or a parameter without a ' +
  'placeholder, is invalid_arguments. Returns the columns with their engine type names, the rows ' +
  'as arrays of JSON scalars, the row count, whether rows were dropped at the target limits, and ' +
  'the duration. It never returns the credential: any echo of it is replaced by ' +
  '[redacted:<field>]. A database error after sign-in is upstream_error with the message the ' +
  'server gave; a database that could not be reached is connection_failed, tls_error, ' +
  'authentication_failed, destination_refused or timeout.';

export const sqlQueryTool: ConnectorTool<SqlOperation> = {
  name: 'sql_query',
  scope: 'actions:sql.read',
  description: SQL_QUERY_DESCRIPTION,
  annotations: {
    title: 'SQL query',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: sqlQuerySchema,
  outputSchema: sqlQueryOutputSchema,
};
