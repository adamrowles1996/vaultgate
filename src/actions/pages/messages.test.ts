import { describe, expect, it } from 'vitest';

import { fieldName } from './form-values.ts';
import { editableConnectors, formFor } from './forms.ts';
import { groupProblems, messageFor } from './messages.ts';

const SWITCHES = { allowAnyCommand: true };

/**
Every policy control of every connector this build can edit, by its submitted name.
*/
function policyPaths(): readonly string[] {
  return editableConnectors().flatMap((kind) =>
    (formFor(kind, SWITCHES)?.fields ?? [])
      .filter((field) => field.document === 'policy')
      .map((field) => fieldName(field)),
  );
}

describe('the validation-message table', () => {
  it('ACT-6 names every policy field of every connector, so no policy problem shows a bare zod message', () => {
    const paths = policyPaths();
    expect(paths.length).toBeGreaterThan(0);
    const bare = paths.filter((path) => messageFor(path, 'detail') === 'detail');
    expect(bare).toStrictEqual([]);
    expect(messageFor('policy.timeout_ms', 'Too big')).toBe(
      'How long one call may run, in milliseconds: 1000 to 300000. (Too big)',
    );
  });

  it('ACT-6 leaves a field the table does not name showing what the check said', () => {
    expect(messageFor('destination.base_url', 'must be an absolute URL')).toBe(
      'must be an absolute URL',
    );
  });
});

describe('groupProblems', () => {
  it('ACT-6 attaches each problem to the control it names and keeps the rest for the page', () => {
    const problems = groupProblems(
      [
        'policy.max_rows: Too big: expected number to be <=10000',
        'policy.max_rows: also wrong',
        'credential.mapping: the item has no "custom.nope" field',
        'a problem that names nothing',
      ],
      ['policy.max_rows', 'policy.operations'],
    );
    expect(problems.isEmpty).toBe(false);
    expect(problems.byPath.get('policy.max_rows')).toStrictEqual([
      'The most rows one query returns: 1 to 10000. Further rows are dropped. (Too big: expected number to be <=10000)',
      'The most rows one query returns: 1 to 10000. Further rows are dropped. (also wrong)',
    ]);
    expect(problems.byPath.get('policy.operations')).toBeUndefined();
    expect(problems.rest).toStrictEqual([
      'credential.mapping: the item has no "custom.nope" field',
      'a problem that names nothing',
    ]);
  });

  it('ACT-6 reports nothing at all when the save was not rejected', () => {
    const problems = groupProblems([], ['policy.max_rows']);
    expect(problems.isEmpty).toBe(true);
    expect(problems.rest).toStrictEqual([]);
    expect(problems.byPath.size).toBe(0);
  });
});
