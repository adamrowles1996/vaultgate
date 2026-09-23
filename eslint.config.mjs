// ESLint flat config. Every rule here is an error: CI runs with
// --max-warnings=0, so a warning would be indistinguishable from an error
// anyway, and "error" keeps the signal honest.
//
// The rule set is deliberately opinionated:
//   - typescript-eslint strictTypeChecked + stylisticTypeChecked (type-aware).
//   - Anti-monolith caps: 300 lines per file, 60 per function, complexity 10.
//   - Dependency boundaries: process.env is read in exactly one module;
//     child processes are spawned in exactly one module.
//   - No console: structured logging only (pino).
//   - Node (eslint-plugin-n), regex safety (eslint-plugin-regexp), unicorn's
//     modern-JavaScript rules and vitest hygiene layered on top.
//   - Prettier runs last and reports drift as lint errors.
import js from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import vitest from '@vitest/eslint-plugin';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import * as regexp from 'eslint-plugin-regexp';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const MAX_FILE_LINES = 300;
const MAX_FUNCTION_LINES = 60;
const MAX_CYCLOMATIC_COMPLEXITY = 10;
const MAX_COGNITIVE_COMPLEXITY = 15;
const MAX_PARAMS = 4;
const MAX_DEPTH = 3;

/**
The only module allowed to read process.env. Everything else takes a Config.
*/
const CONFIG_BOUNDARY_FILES = [
  'src/config/**/*.ts',
  'src/main.ts',
  'src/cli.ts',
  'src/test-support/integration-environment.ts',
];

/**
The only module allowed to spawn a child process (the managed `bw serve`).
*/
const CHILD_PROCESS_BOUNDARY_FILES = ['src/bitwarden/serve-process.ts'];

/**
The only modules allowed to end the process: the server and the CLI entrypoints.
*/
const PROCESS_EXIT_BOUNDARY_FILES = ['src/main.ts', 'src/cli.ts'];

const childProcessRestriction = {
  paths: [
    {
      name: 'child_process',
      message: 'Spawning processes is confined to src/bitwarden/serve-process.ts.',
    },
    {
      name: 'node:child_process',
      message: 'Spawning processes is confined to src/bitwarden/serve-process.ts.',
    },
  ],
};

const sharedRules = {
  // -- Imports -----------------------------------------------------------
  'import-x/order': [
    'error',
    {
      groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
      'newlines-between': 'always',
      alphabetize: { order: 'asc', caseInsensitive: true },
    },
  ],
  'import-x/no-cycle': ['error', { maxDepth: 5 }],
  'import-x/no-self-import': 'error',
  'import-x/no-useless-path-segments': 'error',
  'import-x/first': 'error',
  'import-x/no-duplicates': 'error',
  'import-x/no-extraneous-dependencies': 'error',
  'unused-imports/no-unused-imports': 'error',
  'unused-imports/no-unused-vars': [
    'error',
    {
      vars: 'all',
      varsIgnorePattern: '^_',
      args: 'after-used',
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],

  // -- General correctness -----------------------------------------------
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  curly: ['error', 'all'],
  'no-implicit-coercion': 'error',
  'no-param-reassign': ['error', { props: true }],
  'no-console': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'prefer-const': 'error',
  'no-restricted-imports': ['error', childProcessRestriction],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'MemberExpression[object.name="process"][property.name="env"]',
      message: 'Read the environment only in src/config/; everything else receives a Config.',
    },
  ],

  // -- Anti-monolith caps ------------------------------------------------
  'max-lines': ['error', { max: MAX_FILE_LINES, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': [
    'error',
    { max: MAX_FUNCTION_LINES, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  complexity: ['error', MAX_CYCLOMATIC_COMPLEXITY],
  'max-params': ['error', MAX_PARAMS],
  'max-depth': ['error', MAX_DEPTH],
  'sonarjs/cognitive-complexity': ['error', MAX_COGNITIVE_COMPLEXITY],

  // -- Disable directives must justify themselves ------------------------
  '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
  '@eslint-community/eslint-comments/no-unlimited-disable': 'error',

  // -- Node ---------------------------------------------------------------
  'n/prefer-node-protocol': 'error',
  // ADR 0001 chose node:sqlite (no experimental warning since Node 24); eslint-plugin-n's
  // feature table still lists it as experimental.
  'n/no-unsupported-features/node-builtins': ['error', { ignores: ['sqlite'] }],
  'n/no-process-exit': 'error',
  'n/no-sync': 'off', // start-up and repo scripts read files synchronously on purpose
  'n/no-unpublished-import': 'off', // private package; knip and dependency-cruiser cover dev deps
  'n/no-missing-import': 'off', // TypeScript and import-x resolve .ts imports
  'n/hashbang': 'off', // scripts are invoked through `node scripts/…`, never as executables

  // -- Unicorn: keep the rules that catch bugs and naming drift -----------
  'unicorn/filename-case': ['error', { case: 'kebabCase' }],
  'unicorn/prevent-abbreviations': 'off',
  'unicorn/no-null': 'off', // node:sqlite and Web APIs speak null
  'unicorn/no-array-reduce': 'off',
  'unicorn/no-process-exit': 'off', // eslint-plugin-n owns this with a boundary exemption
  'unicorn/import-style': 'off',
};

const typeScriptRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/explicit-module-boundary-types': 'error',
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/consistent-type-exports': 'error',
  '@typescript-eslint/no-import-type-side-effects': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/require-await': 'error',
  '@typescript-eslint/return-await': ['error', 'in-try-catch'],
  '@typescript-eslint/no-unnecessary-condition': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': [
    'error',
    { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: true },
  ],
  '@typescript-eslint/prefer-readonly': 'error',
  '@typescript-eslint/prefer-nullish-coalescing': [
    'error',
    { ignorePrimitives: { string: true, number: true, boolean: true, bigint: true } },
  ],
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    { allowNumber: true, allowBoolean: false, allowAny: false, allowNullish: false },
  ],
  '@typescript-eslint/no-unused-vars': 'off', // delegated to unused-imports
};

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },
  js.configs.recommended,
  eslintComments.recommended,
  nodePlugin.configs['flat/recommended-module'],
  regexp.configs['flat/recommended'],
  unicorn.configs.recommended,
  {
    plugins: { 'unused-imports': unusedImports, sonarjs },
  },

  // -- TypeScript sources (type-aware) -----------------------------------
  {
    files: ['src/**/*.ts', 'vitest.config.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.json' }),
        createNodeResolver(),
      ],
    },
    rules: { ...sharedRules, ...typeScriptRules },
  },

  // -- Boundary exemptions -----------------------------------------------
  {
    files: CONFIG_BOUNDARY_FILES,
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: CHILD_PROCESS_BOUNDARY_FILES,
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: PROCESS_EXIT_BOUNDARY_FILES,
    rules: { 'n/no-process-exit': 'off' },
  },

  // -- Tests: same type-aware rules, minus the ones tests legitimately break
  {
    files: ['src/**/*.test.ts', 'src/test-support/**/*.ts'],
    extends: [vitest.configs.recommended],
    settings: { vitest: { typecheck: true } },
    rules: {
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/expect-expect': 'error',
      'vitest/no-conditional-expect': 'error',
      'vitest/no-conditional-in-test': 'error',
      'vitest/consistent-test-it': ['error', { fn: 'it', withinDescribe: 'it' }],
      'vitest/valid-title': 'error',
      'vitest/prefer-strict-equal': 'error',
      'vitest/no-standalone-expect': 'error',
      'vitest/require-top-level-describe': 'error',
      'unicorn/prefer-https': 'off', // fixtures deliberately contain plain-http URLs to reject
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'sonarjs/cognitive-complexity': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // -- Plain JavaScript (config and repo scripts) ------------------------
  {
    files: ['*.mjs', 'scripts/**/*.mjs'],
    extends: [importX.flatConfigs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    settings: { 'import-x/resolver-next': [createNodeResolver()] },
    rules: {
      ...sharedRules,
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
      'n/no-process-exit': 'off', // repo scripts are command-line gates; a non-zero exit is their output
    },
  },

  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  prettierRecommended,
);
