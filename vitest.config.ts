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
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // main.ts is the process entrypoint (argument parsing, signal wiring,
      // process.exit). It is exercised by the CI smoke job, which boots the
      // real binary and probes /healthz, rather than by unit tests.
      exclude: ['src/**/*.test.ts', 'src/test-support/**', 'src/main.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
