// Requirement-citation gate for the actions layer (docs/PLAN.md M14 exit).
// Every `ACT-n` the specification defines must be named by at least one test,
// so the traceability the specification claims is a fact rather than a habit.
// A requirement no test can prove yet is listed below with the milestone that
// will prove it; anything else missing fails the build.
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SPEC_FILES = [
  'docs/spec/13-actions.md',
  'docs/spec/13a-actions-operations.md',
  'docs/spec/14-actions-connectors.md',
  'docs/spec/14a-code-connector.md',
];

const TEST_ROOT = 'src';
const PYTHON_TEST_ROOT = 'sidecars/code/tests';
const PREFIX = 'ACT-';

/**
 * A requirement is defined where the specification writes it in bold at the
 * head of its clause: `- **ACT-42** On protocol version …`.
 */
const DEFINITION = /\*\*(ACT-\d+)\*\*/g;

/**
 * A test cites a requirement by naming it in the title of an `it`, `test` or
 * `describe` block, which is how CONTRIBUTING.md asks for them.
 */
const TEST_TITLE = /\b(?:it|test|describe)\(\s*[`'"]([^`'"]*)/g;
const CITATION = /\bACT-\d+\b/g;

/**
 * Requirements no test proves, each with the reason. `M15` marks the
 * `browser` connector (spec 13.6.6 and 14.7) and `M16` the `code` connector
 * (spec 13.6.7 and 14.8, ADR 0008), each deliberately unimplemented until its
 * milestone; their tests land with them. Remove an entry when its milestone
 * lands — never to silence this gate.
 */
const PENDING = [
  {
    milestone: 'M15',
    numbers: [29, 30, 31, 32, 33, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102],
  },
  {
    milestone: 'M16',
    numbers: [103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 119, 120],
  },
];
const ALLOWED = new Map(
  PENDING.flatMap(({ milestone, numbers }) =>
    numbers.map((number) => [`${PREFIX}${number}`, milestone]),
  ),
);

function bySequence(left, right) {
  return Number(left.slice(PREFIX.length)) - Number(right.slice(PREFIX.length));
}

function definedRequirements() {
  const defined = new Set();
  for (const file of SPEC_FILES) {
    const matches = readFileSync(file, 'utf8').matchAll(DEFINITION);
    for (const [, id] of matches) {
      defined.add(id);
    }
  }
  return defined;
}

async function testFiles(directory, isTest) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await testFiles(path, isTest)));
    } else if (isTest(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function vitestTitles(text) {
  return text
    .matchAll(TEST_TITLE)
    .map(([, title]) => title)
    .toArray();
}

/**
 * The code sidecar's pytest suite cites a requirement in the first line of a
 * test function's docstring: `"""ACT-106: symbolic links are skipped."""`.
 * A line starting `def test_` opens a signature, the first line ending in `:`
 * closes it, and the next non-blank line is the docstring or there is none.
 */
function pytestTitles(text) {
  const titles = [];
  let state = 'code';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (state === 'body' && line !== '') {
      if (line.startsWith('"""')) {
        titles.push(line);
      }
      state = 'code';
    }
    if (line.startsWith('def test_')) {
      state = 'signature';
    }
    if (state === 'signature' && line.endsWith(':')) {
      state = 'body';
    }
  }
  return titles;
}

function citationsIn(path, titlesOf) {
  const titles = titlesOf(readFileSync(path, 'utf8'));
  return titles.flatMap((title) => title.match(CITATION) ?? []);
}

async function citedRequirements() {
  const vitest = await testFiles(TEST_ROOT, (name) => name.endsWith('.test.ts'));
  const pytest = await testFiles(
    PYTHON_TEST_ROOT,
    (name) => name.startsWith('test_') && name.endsWith('.py'),
  );
  return new Set([
    ...vitest.flatMap((file) => citationsIn(file, vitestTitles)),
    ...pytest.flatMap((file) => citationsIn(file, pytestTitles)),
  ]);
}

const defined = definedRequirements();
const cited = await citedRequirements();
const problems = [];

for (const id of [...defined].toSorted(bySequence)) {
  if (!ALLOWED.has(id) && !cited.has(id)) {
    problems.push(`${id} is defined in the specification but no test names it`);
  }
}
for (const [id, reason] of ALLOWED) {
  if (!defined.has(id)) {
    problems.push(`${id} is allowed as "${reason}" but the specification no longer defines it`);
  }
}

if (problems.length > 0) {
  console.error('Requirement citation gate failed:');
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

const allowed = ALLOWED.keys()
  .filter((id) => defined.has(id))
  .toArray().length;
console.log(
  `Requirement citation gate passed: ${String(defined.size - allowed)} of ${String(defined.size)} ` +
    `actions requirements are cited by a test; ${String(allowed)} are allowed without one.`,
);
