import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
    testTimeout: 5_000,
    hookTimeout: 5_000,
    pool: 'forks',
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 82,
        branches: 77,
        functions: 87,
        lines: 82,
      },
    },
  },
});
