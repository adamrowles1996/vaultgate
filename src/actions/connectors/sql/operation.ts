/**
 * `sql_query` and `sql_execute` as the connector declares them (spec
 * §13.6.4): the arguments both take (ACT-23), the two strict results (ACT-24,
 * ACT-25), the LLM-facing descriptions (ACT-17) and the annotations of the
 * 13.6.1 rows (ACT-18). The MCP layer puts `target` in front of the
 * arguments. The arguments are identical, so the tool name is what tells the
 * connector which of the two it is serving.
 */
import { z } from 'zod';

import type { OutputSchema } from '../../../mcp/tools/definition.ts';
import type { ConnectorTool } from '../connector.ts';

export const SQL_QUERY_TOOL = 'sql_query';
export const SQL_EXECUTE_TOOL = 'sql_execute';

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

export const sqlOperationSchema = z.strictObject({
  statement: statementSchema,
  params: parametersSchema,
});

export type SqlOperation = z.output<typeof sqlOperationSchema>;

const columnSchema = z.strictObject({ name: z.string(), type: z.string() });

const columnsSchema = z
  .array(columnSchema)
  .describe('The result columns in order, each with the name and the engine type name.');

const rowsSchema = z
  .array(z.array(sqlScalarSchema))
  .describe(
    'The rows, each an array of values in column order. Dates are ISO 8601 strings, binary ' +
      'is base64, decimals and 64-bit integers are strings.',
  );

const truncatedSchema = z
  .boolean()
  .describe('True when rows beyond the target row or output limit were dropped.');

export const sqlQueryOutputSchema: OutputSchema = z.strictObject({
  columns: columnsSchema,
  rows: rowsSchema,
  row_count: z.number().int().describe('The number of rows returned.'),
  truncated: truncatedSchema,
  duration_ms: z.number().int(),
});

export const sqlExecuteOutputSchema: OutputSchema = z.strictObject({
  rows_affected: z
    .number()
    .int()
    .describe('The number of rows the statement inserted, updated or deleted.'),
  columns: columnsSchema,
  rows: rowsSchema.describe(
    'The rows the statement returned through RETURNING or OUTPUT, empty when it returned none.',
  ),
  truncated: truncatedSchema,
  duration_ms: z.number().int(),
});

const SHARED_DESCRIPTION =
  '`target` must be a name returned by actions_list_targets, and its `engine` there tells you ' +
  'which dialect and which placeholders to write. `statement` must be exactly one statement. ' +
  'Put every value in `params` and reference them positionally as $1…$n (PostgreSQL) or ' +
  '@p1…@pn (SQL Server); a placeholder without a parameter, or a parameter without a ' +
  'placeholder, is invalid_arguments. The result never contains the credential: any echo of it ' +
  'is replaced by [redacted:<field>]. A database error after sign-in is upstream_error with the ' +
  'message the server gave; a database that could not be reached is connection_failed, ' +
  'tls_error, authentication_failed, destination_refused or timeout.';

export const SQL_QUERY_DESCRIPTION =
  'Runs one read-only SQL statement against a database the operator configured, signed in with ' +
  'a credential from the vault that you never see. The statement’s first keyword must be ' +
  'SELECT, WITH or EXPLAIN and it must contain no writing, executing or session-changing ' +
  'keyword outside a string or a comment; anything else is refused with policy_denied before ' +
  `any connection is opened. ${SHARED_DESCRIPTION} Returns the columns with their engine type ` +
  'names, the rows as arrays of JSON scalars, the row count, whether rows were dropped at the ' +
  'target limits, and the duration.';

export const SQL_EXECUTE_DESCRIPTION =
  'Runs one writing SQL statement against a database the operator configured, signed in with a ' +
  'credential from the vault that you never see. The statement must classify as data ' +
  'manipulation (INSERT, UPDATE, DELETE, MERGE) or, when the target policy allows that class, ' +
  'as schema change (CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, DENY); a read statement ' +
  'belongs in sql_query and anything else is refused with policy_denied before any connection ' +
  'is opened. The target may also carry a list of statement patterns, and a statement outside ' +
  `it is refused with reason statement_pattern. ${SHARED_DESCRIPTION} It runs in its own ` +
  'transaction, committed when it succeeds and rolled back on any error or timeout, and ' +
  'returns the number of rows affected, any rows the statement returned through RETURNING or ' +
  'OUTPUT, and the duration. Every call is a write: the operator may require a human ' +
  'confirmation for it, which you cannot supply yourself.';

export const sqlQueryTool: ConnectorTool<SqlOperation> = {
  name: SQL_QUERY_TOOL,
  scope: 'actions:sql.read',
  description: SQL_QUERY_DESCRIPTION,
  annotations: {
    title: 'SQL query',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: sqlOperationSchema,
  outputSchema: sqlQueryOutputSchema,
};

export const sqlExecuteTool: ConnectorTool<SqlOperation> = {
  name: SQL_EXECUTE_TOOL,
  scope: 'actions:sql.write',
  description: SQL_EXECUTE_DESCRIPTION,
  annotations: {
    title: 'SQL execute',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: sqlOperationSchema,
  outputSchema: sqlExecuteOutputSchema,
};
