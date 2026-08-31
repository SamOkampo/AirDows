'use strict';

const assert = require('node:assert/strict');

async function main() {
  const raw = process.env.AIRDOWS_STAGING_URL;
  assert.ok(raw, 'Set AIRDOWS_STAGING_URL to the isolated staging origin.');
  const origin = new URL(raw).origin;

  const health = await fetch(new URL('/healthz', origin));
  assert.equal(health.status, 200, 'staging health probe failed');
  assert.deepEqual(await health.json(), { status: 'ok', service: 'airdows' });

  const handshake = await fetch(new URL('/socket.io/?EIO=4&transport=polling', origin));
  assert.equal(handshake.status, 200, 'Socket.IO polling handshake failed');
  assert.match(await handshake.text(), /^0\{/, 'Socket.IO did not return an Engine.IO open packet');

  console.log(`AirDows staging smoke passed for ${origin}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
