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
  'policy.rate_limit_per_minute': 'How many calls this connection accepts per minute: 1 to 600.',
  'policy.confirm_writes':
    'Whether every non-read call asks a human to confirm it first. On for a new connection.',
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
    'read runs sql_query; write also runs sql_execute. A connection that allows write must ' +
    'allow read as well.',
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
    'Whether the connection accepts any command at all. It needs the deployment switch ' +
    'VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND, and every call is audited with the full command.',
  // code (§14.8)
  'destination.repository':
    'The repository as owner/name, as GitHub shows it: type it, or choose one the token can read.',
  'destination.ref':
    'A branch or tag name, or a full 40-character commit SHA; empty for the default branch.',
  'policy.content':
    'The content agents may search, at least one of code, docs and config; a call may narrow it.',
  'policy.allow_read': 'Whether code_read may return whole files, up to the most lines per read.',
  'policy.allow_ref':
    'Whether a call may name another branch, tag, commit or pull request than the configured ref.',
  'policy.include':
    'gitignore patterns of the files to index, one per line, at most 100 of up to 1024 ' +
    'characters; empty indexes every file.',
  'policy.exclude':
    'gitignore patterns of the files never indexed, one per line, at most 100 of up to 1024 ' +
    'characters. Replacing the list replaces the defaults.',
  'policy.max_top_k': 'The most results one search may ask for: 1 to 200.',
  'policy.max_read_lines': 'The most lines one code_read returns: 1 to 2000.',
  'policy.build_wait_s':
    'How long a call waits for an index being built, in seconds: 0 to 290, and at least 10 ' +
    'seconds less than the call timeout.',
  'policy.refresh_interval_s':
    'How long a resolution of the configured ref stands, in seconds: 60 to 86400.',
  'policy.max_archive_bytes':
    'The largest archive a build downloads, in bytes: 1048576 to 1073741824.',
  'policy.max_files': 'The most files a snapshot holds: 1 to 200000.',
  'policy.max_total_bytes':
    'The largest a snapshot may be uncompressed, in bytes: 1048576 to 4294967296.',
  'policy.max_file_bytes':
    'The largest file a snapshot keeps, in bytes: 1024 to 16777216; larger files are skipped.',
  'policy.build_timeout_s': 'How long a build may run, in seconds: 10 to 3600.',
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
