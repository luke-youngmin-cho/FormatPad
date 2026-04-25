import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  retries: process.env.CI ? 2 : 0,
  reporter: [['html'], ['list']],
  projects: [
    {
      name: 'electron',
      testMatch: 'tests/e2e/*.spec.ts',
    },
    {
      name: 'web-chromium',
      use: { ...devices['Desktop Chrome'] },
      testMatch: 'tests/e2e/web/*.spec.ts',
    },
    {
      name: 'web-firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: 'tests/e2e/web/*.spec.ts',
    },
    {
      name: 'web-webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: 'tests/e2e/web/*.spec.ts',
    },
  ],
});
