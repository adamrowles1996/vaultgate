import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
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
