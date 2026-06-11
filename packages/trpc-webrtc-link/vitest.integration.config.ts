import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 10_000,
    pool: 'forks',
    maxWorkers: 1,
  },
});
