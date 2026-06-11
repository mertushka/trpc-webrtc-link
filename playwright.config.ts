import { defineConfig } from '@playwright/test';

const exampleWorkspace = '@mertushka/trpc-webrtc-link-example-basic';

export default defineConfig({
  testDir: './examples/basic/e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['line'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `npm run start:server --workspace ${exampleWorkspace}`,
      url: 'http://127.0.0.1:8787/health',
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev:browser --workspace ${exampleWorkspace} -- --strictPort`,
      url: 'http://127.0.0.1:5173',
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});
