import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    // `unit` is the default (`npm test`); `integration` needs a real Bitwarden
    // CLI and account (src/test-support/integration-environment.ts) and runs
    // through `npm run test:integration` only.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 120_000,
          // Above the suite's readiness deadline (one failed start plus a clean restart).
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // main.ts and cli.ts are the process entrypoints (environment, argument
      // parsing, signal wiring, process.exit). The CI smoke job exercises
      // them, booting the real binary to probe /healthz and running the audit
      // export CLI against a fresh data directory, rather than unit tests.
      exclude: ['src/**/*.test.ts', 'src/test-support/**', 'src/main.ts', 'src/cli.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
