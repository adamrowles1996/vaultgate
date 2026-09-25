// Repository-wide file size gate. ESLint caps TypeScript files; this script
// caps everything git tracks, so a 3 MB fixture or a 2,000-line YAML file
// cannot land unnoticed. Limits are deliberately small: a file that needs
// more room almost always wants splitting instead.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const MAX_BYTES = 64 * 1024;
const MAX_LINES_CODE = 300;
const MAX_LINES_PROSE = 1200;

/**
Generated or externally-authored files that the limits do not apply to: the npm
lockfile, the licence and the code sidecar's `uv` lockfile (every hash of every
wheel it may install).
*/
const EXEMPT = new Set(['package-lock.json', 'LICENSE', 'sidecars/code/uv.lock']);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.mjs',
  '.cjs',
  '.js',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.py',
]);
const PROSE_EXTENSIONS = new Set(['.md']);

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function lineLimitFor(path) {
  const extension = extensionOf(path);
  if (CODE_EXTENSIONS.has(extension)) {
    return MAX_LINES_CODE;
  }
  return PROSE_EXTENSIONS.has(extension) ? MAX_LINES_PROSE : null;
}

function countLines(path) {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) {
    return 0;
  }
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => path.length > 0);
}

function check(path) {
  if (EXEMPT.has(path)) {
    return [];
  }
  const problems = [];
  const bytes = statSync(path).size;
  if (bytes > MAX_BYTES) {
    problems.push(`${path}: ${bytes} bytes exceeds ${MAX_BYTES}`);
  }
  const lineLimit = lineLimitFor(path);
  if (lineLimit !== null) {
    const lines = countLines(path);
    if (lines > lineLimit) {
      problems.push(`${path}: ${lines} lines exceeds ${lineLimit}`);
    }
  }
  return problems;
}

const problems = trackedFiles().flatMap((path) => check(path));
if (problems.length > 0) {
  console.error('File size gate failed:');
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
console.log('File size gate passed.');
