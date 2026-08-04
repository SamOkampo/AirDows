'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const { getEffectivePort } = require('./url-policy.js');

const LOCAL_HOST = '127.0.0.1';

function parsePort(value, label = 'AIRDOWS_E2E_PORT') {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      String(port) !== String(value).trim()) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

function probePort(port, host = LOCAL_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
        resolve(null);
        return;
      }
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address();
      const selectedPort = address && typeof address === 'object' ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else resolve(selectedPort);
      });
    });
  });
}

async function findAvailablePort(host = LOCAL_HOST) {
  const port = await probePort(0, host);
  if (!Number.isSafeInteger(port)) {
    throw new Error('Unable to select an available E2E port.');
  }
  return port;
}

async function createLaunchSettings(environment = process.env) {
  const configuredBaseUrl = String(environment.AIRDOWS_E2E_BASE_URL || '').trim();
  const configuredPort = String(environment.AIRDOWS_E2E_PORT || '').trim();

  if (configuredBaseUrl) {
    const parsedBaseUrl = new URL(configuredBaseUrl);
    if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
      throw new Error('AIRDOWS_E2E_BASE_URL must use HTTP or HTTPS.');
    }
    const basePort = getEffectivePort(parsedBaseUrl);
    if (configuredPort && parsePort(configuredPort) !== basePort) {
      throw new Error('AIRDOWS_E2E_PORT must match AIRDOWS_E2E_BASE_URL.');
    }
    return {
      baseURL: parsedBaseUrl.origin,
      port: basePort,
      startLocalServer: false,
      source: 'external'
    };
  }

  if (configuredPort) {
    const port = parsePort(configuredPort);
    if (await probePort(port) !== port) {
      throw new Error(`AIRDOWS_E2E_PORT ${port} is not available.`);
    }
    return {
      baseURL: `http://${LOCAL_HOST}:${port}`,
      port,
      startLocalServer: true,
      source: 'explicit'
    };
  }

  const port = await findAvailablePort();
  return {
    baseURL: `http://${LOCAL_HOST}:${port}`,
    port,
    startLocalServer: true,
    source: 'automatic'
  };
}

async function main() {
  const settings = await createLaunchSettings(process.env);
  if (settings.source === 'automatic') {
    console.log(`[AirDows E2E] Selected available local port ${settings.port}`);
  } else if (settings.source === 'explicit') {
    console.log(`[AirDows E2E] Using requested local port ${settings.port}`);
  } else {
    console.log('[AirDows E2E] Using externally managed base URL');
  }

  const child = spawn(
    process.execPath,
    [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        AIRDOWS_E2E_PORT: String(settings.port),
        AIRDOWS_E2E_BASE_URL: settings.baseURL,
        AIRDOWS_E2E_START_LOCAL_SERVER: settings.startLocalServer ? '1' : '0'
      }
    }
  );

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal));
  }
  child.once('error', (error) => {
    console.error('[AirDows E2E] Playwright could not start:', error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[AirDows E2E] Launcher failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createLaunchSettings,
  findAvailablePort,
  parsePort,
  probePort
};
