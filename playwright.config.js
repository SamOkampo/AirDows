'use strict';

const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

const port = Number.parseInt(process.env.AIRDOWS_E2E_PORT || '43987', 10);
const baseURL = process.env.AIRDOWS_E2E_BASE_URL || `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: 'transfer-performance.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: {
    timeout: 15_000
  },
  forbidOnly: Boolean(process.env.CI),
  outputDir: path.join('test-results', 'playwright'),
  reporter: [['line']],
  use: {
    baseURL,
    acceptDownloads: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ],
  webServer: {
    command: 'node e2e/server.js',
    url: `${baseURL}/app`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 5_000
    },
    env: {
      AIRDOWS_E2E_PORT: String(port),
      AIRDOWS_E2E_BASE_URL: baseURL
    }
  }
});
