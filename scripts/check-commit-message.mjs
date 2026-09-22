// Conventional Commits gate (https://www.conventionalcommits.org/en/v1.0.0/).
// Used by the commit-msg hook (--file <path>) and by CI on the pull request
// title (--message <text>), because squash merges use the PR title as the
// commit subject.
import { readFileSync } from 'node:fs';

const TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
];
const MAX_SUBJECT_LENGTH = 100; // Dependabot subjects legitimately exceed 72.
const SUBJECT_PATTERN = new RegExp(
  String.raw`^(?:${TYPES.join('|')})(?:\([a-z0-9][a-z0-9-]*\))?!?: \S.*$`,
);

function firstLine(text) {
  return text.split('\n').find((line) => !line.startsWith('#')) ?? '';
}

function readSubject(argv) {
  const fileIndex = argv.indexOf('--file');
  if (fileIndex !== -1 && argv[fileIndex + 1] !== undefined) {
    return firstLine(readFileSync(argv[fileIndex + 1], 'utf8'));
  }
  const messageIndex = argv.indexOf('--message');
  return messageIndex !== -1 && argv[messageIndex + 1] !== undefined
    ? firstLine(argv[messageIndex + 1])
    : null;
}

function validate(subject) {
  if (/^(?:Merge |Revert "|fixup! |squash! )/.test(subject)) {
    return [];
  }
  const problems = [];
  if (!SUBJECT_PATTERN.test(subject)) {
    problems.push(
      `subject must match "<type>(<scope>)?: <description>" with type in ${TYPES.join(', ')}`,
    );
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    problems.push(`subject is ${subject.length} characters; the limit is ${MAX_SUBJECT_LENGTH}`);
  }
  if (subject.endsWith('.')) {
    problems.push('subject must not end with a full stop');
  }
  return problems;
}

const subject = readSubject(process.argv.slice(2));
if (subject === null) {
  console.error('usage: check-commit-message.mjs (--file <path> | --message <text>)');
  process.exit(2);
}
const problems = validate(subject);
if (problems.length > 0) {
  console.error(`Rejected commit subject: "${subject}"`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
