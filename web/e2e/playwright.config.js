// Browser tests for the web client, against the running stack (docker compose up -d, with
// AUTH_MODE=console so sign-in codes appear in the api's log). Run: npm test (in web/e2e).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: './test-results',
});
