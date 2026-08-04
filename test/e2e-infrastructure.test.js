const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { isAllowedE2EUrl } = require('../e2e/url-policy.js');
const {
  createLaunchSettings,
  findAvailablePort
} = require('../e2e/run.js');

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function loadPlaywrightConfig(environment) {
  const keys = [
    'AIRDOWS_E2E_PORT',
    'AIRDOWS_E2E_BASE_URL',
    'AIRDOWS_E2E_START_LOCAL_SERVER'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const configPath = require.resolve('../playwright.config.js');

  try {
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    delete require.cache[configPath];
    return require(configPath);
  } finally {
    delete require.cache[configPath];
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('E2E URL policy allows local HTTP and its WebSocket transport', () => {
  const baseURL = 'http://127.0.0.1:45123';
  assert.equal(isAllowedE2EUrl('http://127.0.0.1:45123/app', baseURL), true);
  assert.equal(isAllowedE2EUrl('ws://127.0.0.1:45123/socket.io/', baseURL), true);
  assert.equal(isAllowedE2EUrl('http://localhost:45123/app', baseURL), false);
});

test('E2E URL policy allows configured HTTPS and implicit default ports', () => {
  const baseURL = 'https://example.test';
  assert.equal(isAllowedE2EUrl('https://example.test/app', baseURL), true);
  assert.equal(isAllowedE2EUrl('https://example.test:443/app', baseURL), true);
  assert.equal(isAllowedE2EUrl('wss://example.test/socket.io/', baseURL), true);
  assert.equal(
    isAllowedE2EUrl('http://example.test:80/app', 'http://example.test'),
    true
  );
});

test('E2E URL policy blocks different hosts, ports, and unsupported protocols', () => {
  const baseURL = 'https://example.test:45123';
  assert.equal(isAllowedE2EUrl('https://outside.test:45123/app', baseURL), false);
  assert.equal(isAllowedE2EUrl('https://example.test:45124/app', baseURL), false);
  assert.equal(isAllowedE2EUrl('ftp://example.test:45123/file', baseURL), false);
  assert.equal(isAllowedE2EUrl('data:text/plain,private', baseURL), false);
});

test('automatic E2E launch selects a port that is available to the local server', async () => {
  const settings = await createLaunchSettings({});
  assert.equal(settings.startLocalServer, true);
  assert.equal(settings.source, 'automatic');
  assert.equal(settings.baseURL, `http://127.0.0.1:${settings.port}`);

  const server = await listenOnPort(settings.port);
  await closeServer(server);
});

test('explicit E2E port is preserved when available', async () => {
  const availablePort = await findAvailablePort();
  const settings = await createLaunchSettings({
    AIRDOWS_E2E_PORT: String(availablePort)
  });

  assert.deepEqual(settings, {
    baseURL: `http://127.0.0.1:${availablePort}`,
    port: availablePort,
    startLocalServer: true,
    source: 'explicit'
  });
});

test('external E2E base URL disables the local Playwright web server', async () => {
  assert.deepEqual(
    await createLaunchSettings({
      AIRDOWS_E2E_BASE_URL: 'https://example.test'
    }),
    {
      baseURL: 'https://example.test',
      port: 443,
      startLocalServer: false,
      source: 'external'
    }
  );

  const config = loadPlaywrightConfig({
    AIRDOWS_E2E_BASE_URL: 'https://example.test',
    AIRDOWS_E2E_PORT: '443',
    AIRDOWS_E2E_START_LOCAL_SERVER: '0'
  });
  assert.equal(config.use.baseURL, 'https://example.test');
  assert.equal(config.webServer, undefined);
});

test('local Playwright config propagates one endpoint to browser and web server', () => {
  const config = loadPlaywrightConfig({
    AIRDOWS_E2E_BASE_URL: 'http://127.0.0.1:45123',
    AIRDOWS_E2E_PORT: '45123',
    AIRDOWS_E2E_START_LOCAL_SERVER: '1'
  });

  assert.equal(config.use.baseURL, 'http://127.0.0.1:45123');
  assert.equal(config.webServer.url, 'http://127.0.0.1:45123/app');
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.deepEqual(config.webServer.env, {
    AIRDOWS_E2E_PORT: '45123',
    AIRDOWS_E2E_BASE_URL: 'http://127.0.0.1:45123'
  });
});
