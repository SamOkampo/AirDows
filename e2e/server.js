'use strict';

// Dedicated Playwright server process; kept outside node:test discovery patterns.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const projectRoot = path.resolve(__dirname, '..');
const resultsDirectory = path.join(projectRoot, 'test-results');
const serverLogPath = path.join(resultsDirectory, 'server.log');
const port = Number.parseInt(process.env.AIRDOWS_E2E_PORT || '43987', 10);
const baseURL = process.env.AIRDOWS_E2E_BASE_URL || `http://127.0.0.1:${port}`;

fs.mkdirSync(resultsDirectory, { recursive: true });
fs.writeFileSync(serverLogPath, '', 'utf8');

function sanitizeLog(value) {
  return String(value)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]{0,4}\b/gi, '[redacted-ip]')
    .replace(/\b\d{4}\b/g, '[redacted-four-digits]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]');
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const formatted = sanitizeLog(util.formatWithOptions(
      { colors: false, depth: 3, maxArrayLength: 20 },
      ...args
    ));
    fs.appendFileSync(serverLogPath, `[${level}] ${formatted}\n`, 'utf8');
    original(...args);
  };
}

Object.assign(process.env, {
  PORT: String(port),
  NODE_ENV: 'test',
  ALLOWED_ORIGINS: baseURL,
  RAILWAY_ENVIRONMENT_ID: '',
  METRICS_DATABASE_URL: '',
  DATABASE_URL: '',
  METERED_API_KEY: '',
  TURN_URLS: '',
  TURN_USERNAME: '',
  TURN_CREDENTIAL: '',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  ADMIN_DASHBOARD_TOKEN: ''
});

require(path.join(projectRoot, 'server.js'));
