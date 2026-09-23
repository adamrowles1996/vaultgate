// Module-graph rules (spec §02.2). ESLint stops a file importing the wrong
// builtin; this stops a layer importing the wrong layer.
//
// Layers, from the bottom up:
//   result, config, logger,     foundation: import nothing above themselves
//   net, crypto, scopes, auth  (scopes: the one scope registry; auth: the
//                               bearer-token contract both oauth and mcp use)
//   storage                     no feature knowledge
//   audit                       the event shape and the store sink every
//                               feature records through; knows no feature
//   identity, oauth, mcp,       features: independent of each other except
//   bitwarden                   through interfaces in the layers below them
//   http                        composition of features into routes
//   main.ts, cli.ts             process entrypoints
const RUNTIME = { path: '^src/', pathNot: [String.raw`\.test\.ts$`, '^src/test-support/'] };
const TEST_CODE = [String.raw`\.test\.ts$`, '^src/test-support/'];

/**
@type {import('dependency-cruiser').IConfiguration}
*/
export default {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      severity: 'error',
      comment: 'Every module is reachable from main.ts or a test; delete what is not.',
      from: { orphan: true, pathNot: [String.raw`\.d\.ts$`] },
      to: {},
    },
    {
      name: 'runtime-must-not-import-test-code',
      severity: 'error',
      from: RUNTIME,
      to: { path: TEST_CODE },
    },
    {
      name: 'runtime-must-not-import-dev-dependencies',
      severity: 'error',
      from: RUNTIME,
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'foundation-imports-nothing-above-itself',
      severity: 'error',
      from: { path: '^src/(result|config|logger|net|scopes|auth)' },
      to: { path: '^src/(storage|identity|oauth|mcp|bitwarden|audit|http)/' },
    },
    {
      name: 'storage-knows-no-features',
      severity: 'error',
      from: { path: '^src/storage/' },
      to: { path: '^src/(identity|oauth|mcp|bitwarden|audit|http)/' },
    },
    {
      name: 'audit-knows-no-features',
      severity: 'error',
      comment:
        'identity, oauth and mcp record events through src/audit/ (one AuditEvent shape, one sink); the audit module never looks back up at them.',
      from: { path: '^src/audit/' },
      to: { path: '^src/(identity|oauth|mcp|bitwarden)/' },
    },
    {
      name: 'mcp-uses-the-vault-interface-not-bitwarden',
      severity: 'error',
      comment: 'Tools depend on VaultClient; only composition wires the bw serve implementation.',
      from: { path: '^src/mcp/' },
      to: { path: '^src/bitwarden/' },
    },
    {
      name: 'oauth-is-independent-of-mcp-and-the-vault',
      severity: 'error',
      comment:
        'The bearer contract (TokenVerifier, VerifiedToken) and the scope registry live in src/auth/ and src/scopes/; nothing crosses directly.',
      from: { path: '^src/oauth/' },
      to: { path: '^src/(mcp|bitwarden)/' },
    },
    {
      name: 'identity-is-independent-of-other-features',
      severity: 'error',
      from: { path: '^src/identity/' },
      to: { path: '^src/(oauth|mcp|bitwarden)/' },
    },
    {
      name: 'features-do-not-import-the-composition-layer',
      severity: 'error',
      from: { path: '^src/(storage|identity|oauth|mcp|bitwarden|audit)/' },
      to: { path: String.raw`^src/(http/|main\.ts$|cli\.ts$)` },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: ['^(punycode|domain|constants|sys|_linklist)$'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-dependency-outside-package-json',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'no-duplicate-dependency-types',
      severity: 'error',
      from: {},
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
      extensions: ['.ts', '.mjs', '.js'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
