'use strict';

const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');
const { getEffectivePort } = require('./e2e/url-policy.js');

if (!process.env.AIRDOWS_E2E_BASE_URL) {
  throw new Error('Run Playwright through npm run test:e2e so an available port is selected.');
}

const parsedBaseURL = new URL(process.env.AIRDOWS_E2E_BASE_URL);
const baseURL = parsedBaseURL.origin;
const port = getEffectivePort(parsedBaseURL);
const configuredPort = Number.parseInt(process.env.AIRDOWS_E2E_PORT || '', 10);
if (!Number.isSafeInteger(port) || configuredPort !== port) {
  throw new Error('The E2E base URL and port must identify the same endpoint.');
}
const startLocalServer = process.env.AIRDOWS_E2E_START_LOCAL_SERVER === '1';

const config = {
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
};

if (startLocalServer) {
  config.webServer = {
    command: 'node e2e/server.js',
    url: new URL('/app', `${baseURL}/`).href,
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
  };
}

module.exports = defineConfig(config);
