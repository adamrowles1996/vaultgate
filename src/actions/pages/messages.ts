/**
 * Turning a rejected save into something an operator can act on (ACT-6).
 * Every check reports `"<document>.<field>: <detail>"`, and a form control is
 * named `"<document>.<field>"`, so a problem finds its control by its path
 * alone. The detail a zod issue carries is precise but terse ("Too big:
 * expected number to be <=300000"), so the table below adds the sentence
 * that says what the field is for; a path the table does not name shows the
 * detail on its own. Adding a policy field adds a row here, never a branch.
 */
const FIELD_MESSAGES: Readonly<Record<string, string>> = {
  // Common policy fields (ACT-1, §13.11), on every connector's form.
  'policy.timeout_ms': 'How long one call may run, in milliseconds: 1000 to 300000.',
  'policy.max_output_bytes':
    'How much output one call may return, in bytes: 1024 to 1048576. Longer output is cut and ' +
    'the result says so.',
  'policy.rate_limit_per_minute': 'How many calls this target accepts per minute: 1 to 600.',
  'policy.confirm_writes':
    'Whether every non-read call asks a human to confirm it first. On for a new target.',
  // http (§14.2)
  'policy.allowed_methods':
    'The HTTP methods an agent may use, at least one. GET, HEAD and OPTIONS count as reads; ' +
    'every other method is a write.',
  'policy.allowed_paths':
    'One path pattern per line, at least one, each starting with / and written in normalised ' +
    'form: * matches within one segment, ** crosses /.',
  'policy.allowed_request_headers':
    'One header name per line. authorization, cookie, host, content-length, transfer-encoding, ' +
    'user-agent, any proxy-* header and the header the credential occupies are never allowed.',
  'policy.response_headers': 'One header name per line; every other response header is dropped.',
  'policy.max_body_bytes': 'The largest request body an agent may send, in bytes: 1 to 4194304.',
  'policy.follow_redirects':
    'Whether a redirect is followed; a redirect is re-checked against this policy before it is.',
  'policy.allow_query_credentials':
    'Whether the credential may be put in the query string. The query credential mode needs it.',
  // sql (§14.4)
  'policy.operations':
    'read runs sql_query; write also runs sql_execute. A target that allows write must allow ' +
    'read as well.',
  'policy.max_rows': 'The most rows one query returns: 1 to 10000. Further rows are dropped.',
  'policy.statement_timeout_ms':
    'The server-side statement timeout, in milliseconds: 1000 to 300000. Never longer than the ' +
    'call timeout.',
  'policy.write_classes':
    'Which classes of write sql_execute may run, at least one: dml (INSERT, UPDATE, DELETE, ' +
    'MERGE) or ddl (CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, DENY).',
  'policy.statement_allowlist':
    'One statement pattern per line, matched whole against the statement as the agent wrote it; ' +
    'empty means no statement restriction. Read by sql_execute only.',
  // ssh and winrm (§14.5, §14.6)
  'policy.allowed_commands':
    'One command pattern per line, matched whole against the command as the agent wrote it: * ' +
    'matches within one line. A pattern that would allow every command is refused; say so with ' +
    '"Allow any command" instead.',
  'policy.any_command':
    'Whether the target accepts any command at all. It needs the deployment switch ' +
    'VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND, and every call is audited with the full command.',
};

const SEPARATOR = ': ';

/**
The problems of a rejected save, each attached to the control it names (ACT-6).
*/
export interface FieldProblems {
  /**
  The problems of one control, by its `"<document>.<field>"` name.
  */
  readonly byPath: ReadonlyMap<string, readonly string[]>;
  /**
  The problems that name no control the form draws; the page lists these itself.
  */
  readonly rest: readonly string[];
  readonly isEmpty: boolean;
}

export const NO_PROBLEMS: FieldProblems = { byPath: new Map(), rest: [], isEmpty: true };

/**
The operator-facing message of one problem: the table's sentence with the check's own detail.
*/
export function messageFor(path: string, detail: string): string {
  const guidance = FIELD_MESSAGES[path];
  return guidance === undefined ? detail : `${guidance} (${detail})`;
}

function split(problem: string): { readonly path: string; readonly detail: string } {
  const at = problem.indexOf(SEPARATOR);
  return at === -1
    ? { path: '', detail: problem }
    : { path: problem.slice(0, at), detail: problem.slice(at + SEPARATOR.length) };
}

/**
 * Sorts every problem of a rejected save into the control it names and the
 * rest. `drawn` is the set of control names the form will render, so a
 * problem about something the form has no control for — the vault item's
 * fields, the destination as a whole, an unknown target — is never hidden.
 */
export function groupProblems(problems: readonly string[], drawn: Iterable<string>): FieldProblems {
  const controls = new Set(drawn);
  const byPath = new Map<string, string[]>();
  const rest: string[] = [];
  for (const problem of problems) {
    const { path, detail } = split(problem);
    if (controls.has(path)) {
      const messages = byPath.get(path) ?? [];
      messages.push(messageFor(path, detail));
      byPath.set(path, messages);
    } else {
      rest.push(problem);
    }
  }
  return { byPath, rest, isEmpty: problems.length === 0 };
}
