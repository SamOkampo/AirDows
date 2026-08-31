const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const publicDirectory = path.join(projectRoot, 'public');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('every Umami tracker excludes URL hashes and search parameters', () => {
  const htmlFiles = fs.readdirSync(publicDirectory).filter((file) => file.endsWith('.html'));
  let trackerCount = 0;

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(publicDirectory, file), 'utf8');
    const trackers = html.match(/<script\b[^>]*cloud\.umami\.is\/script\.js[^>]*><\/script>/g) || [];
    trackerCount += trackers.length;
    for (const tracker of trackers) {
      assert.match(tracker, /data-exclude-hash=["']true["']/, `${file} must exclude hashes`);
      assert.match(tracker, /data-exclude-search=["']true["']/, `${file} must exclude search parameters`);
    }
  }

  assert.ok(trackerCount > 0, 'at least one Umami tracker must be present');
});

test('the landing no longer loads or initializes the removed QR transfer tool', () => {
  const landing = readProjectFile('public/index.html');
  const landingStyles = readProjectFile('public/landing.css');
  for (const removedToken of [
    '/js/qrcode-generator.js',
    '/js/qr-manager.js',
    'landing-qr',
    'landing-drop-zone',
    'landing-file-input',
    'stageFiles('
  ]) {
    assert.equal(landing.includes(removedToken), false, `${removedToken} must stay removed`);
  }

  for (const removedSelector of ['.transfer-tool', '.qr-button', '.tool-aside', '.staged-files']) {
    assert.equal(landingStyles.includes(removedSelector), false, `${removedSelector} must stay removed`);
  }
});

test('the retired Pro relay gate is absent from the runtime and public copy', () => {
  const files = [
    'server.js',
    'public/app.html',
    'public/js/app.js',
    'public/js/socket-manager.js',
    'public/js/webrtc-manager.js'
  ];
  const retiredPattern = /AirDows Pro|Modo Pro|Pro Mode|ProRequired|pro-required|relay[_-]limit|FREE_RELAY_BUDGET|relay-budget|requestRelayUpgrade|sendRelayUsage/;

  for (const file of files) {
    assert.doesNotMatch(readProjectFile(file), retiredPattern, `${file} contains retired Pro behavior`);
  }
});

test('the vulnerable transitive ip-address version is overridden', () => {
  const manifest = JSON.parse(readProjectFile('package.json'));
  const lockfile = JSON.parse(readProjectFile('package-lock.json'));

  assert.match(manifest.dependencies['express-rate-limit'], /^\^8\./);
  assert.equal(manifest.overrides['ip-address'], '10.4.0');
  assert.match(lockfile.packages['node_modules/express-rate-limit'].version, /^8\./);
  assert.equal(lockfile.packages['node_modules/ip-address'].version, '10.4.0');
});
