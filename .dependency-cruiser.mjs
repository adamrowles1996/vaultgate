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
//   bitwarden, actions          through interfaces in the layers below them
//                               (actions: ACT-70, type-only imports from
//                               identity/ and mcp/ are the one exception)
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
      to: { path: '^src/(storage|identity|oauth|mcp|bitwarden|audit|actions|http)/' },
    },
    {
      name: 'storage-knows-no-features',
      severity: 'error',
      from: { path: '^src/storage/' },
      to: { path: '^src/(identity|oauth|mcp|bitwarden|audit|actions|http)/' },
    },
    {
      name: 'audit-knows-no-features',
      severity: 'error',
      comment:
        'identity, oauth, mcp and actions record events through src/audit/ (one AuditEvent shape, one sink); the audit module never looks back up at them. The action_calls reader lives here, the writer in actions/ (ACT-62).',
      from: { path: '^src/audit/' },
      to: { path: '^src/(identity|oauth|mcp|bitwarden|actions)/' },
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
      name: 'actions-uses-only-its-allowed-layers',
      severity: 'error',
      comment:
        'ACT-70: src/actions/ may import result, config, logger, net, crypto, scopes, vault, storage and audit; never oauth/, bitwarden/ or http/.',
      from: { path: '^src/actions/' },
      to: { path: '^src/(oauth|bitwarden|http)/' },
    },
    {
      name: 'actions-imports-identity-and-mcp-types-only',
      severity: 'error',
      comment:
        'ACT-70: the guard and session types its pages need and the Tool shape are injected by composition; only type-only imports cross, plus the escaping template, icons and console building blocks every page renderer shares (ID-19).',
      from: { path: '^src/actions/' },
      to: {
        path: '^src/(identity|mcp)/',
        pathNot: [String.raw`^src/identity/pages/(template|icons|ui|console)\.ts$`],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'features-never-import-actions',
      severity: 'error',
      comment:
        'ACT-70: identity/, oauth/ and bitwarden/ reach the actions layer only through callbacks the composition layer wires.',
      from: { path: '^src/(identity|oauth|bitwarden)/' },
      to: { path: '^src/actions/' },
    },
    {
      name: 'actions-never-spawn-a-process',
      severity: 'error',
      comment:
        'ARCH-2, ACT-71: no connector imports child_process; ssh and winrm execute on the remote host only.',
      from: { path: '^src/actions/' },
      to: { dependencyTypes: ['core'], path: '^(node:)?child_process$' },
    },
    {
      name: 'features-do-not-import-the-composition-layer',
      severity: 'error',
      from: { path: '^src/(storage|identity|oauth|mcp|bitwarden|audit|actions)/' },
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
