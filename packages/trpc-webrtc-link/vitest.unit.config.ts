import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
    testTimeout: 5_000,
    hookTimeout: 5_000,
    pool: 'forks',
    maxWorkers: 1,
  },
});
