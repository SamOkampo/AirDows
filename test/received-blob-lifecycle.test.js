'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');

function loadLifecycleFactory() {
  const startAnchor = 'function createReceivedBlobUrlLifecycle';
  const endAnchor = '\nfunction isAutomaticReconnectAllowed';
  const start = appSource.indexOf(startAnchor);
  const end = appSource.indexOf(endAnchor, start);
  assert.notEqual(start, -1, `Missing source anchor: ${startAnchor}`);
  assert.notEqual(end, -1, `Missing source anchor: ${endAnchor}`);
  assert.ok(end > start, 'Received Blob lifecycle source anchors are out of order');

  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${appSource.slice(start, end)}\nthis.factory = createReceivedBlobUrlLifecycle;`,
    context
  );
  return context.factory;
}

function createHarness() {
  const revoked = [];
  const created = [];
  const link = {
    href: '#',
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    }
  };
  const urlApi = {
    createObjectURL(blob) {
      const url = `blob:received-${created.length + 1}`;
      created.push({ blob, url });
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    }
  };
  const lifecycle = loadLifecycleFactory()(link, urlApi);
  return { lifecycle, link, created, revoked };
}

test('two consecutive received files revoke the first URL before installing the second', () => {
  const { lifecycle, link, created, revoked } = createHarness();
  const firstUrl = lifecycle.install({ name: 'first' }, 'first.bin');
  const secondUrl = lifecycle.install({ name: 'second' }, 'second.bin');

  assert.deepEqual(revoked, [firstUrl]);
  assert.equal(created.length, 2);
  assert.equal(lifecycle.getActiveUrl(), secondUrl);
  assert.equal(link.href, secondUrl);
  assert.equal(link.attributes.get('download'), 'second.bin');
});

test('the newest received URL remains valid until explicit cleanup', () => {
  const { lifecycle, revoked } = createHarness();
  lifecycle.install({ name: 'first' }, 'first.bin');
  const newestUrl = lifecycle.install({ name: 'second' }, 'second.bin');

  assert.equal(revoked.includes(newestUrl), false);
  assert.equal(lifecycle.getActiveUrl(), newestUrl);
});

test('application reset revokes the active received URL', () => {
  const { lifecycle, link, revoked } = createHarness();
  const url = lifecycle.install({}, 'reset.bin');
  lifecycle.clear();

  assert.deepEqual(revoked, [url]);
  assert.equal(lifecycle.getActiveUrl(), null);
  assert.equal(link.href, '#');
  assert.match(appSource, /function resetApp\([^)]*\) \{\s*receivedBlobUrls\.clear\(\);/);
});

test('starting send mode revokes the prior received URL', () => {
  const { lifecycle, revoked } = createHarness();
  const url = lifecycle.install({}, 'received.bin');
  lifecycle.clear();

  assert.deepEqual(revoked, [url]);
  assert.match(
    appSource,
    /webrtcManager\.onFileTransferStart = \([^)]*isSending[^)]*\) => \{\s*receivedBlobUrls\.clear\(\);/
  );
});

test('repeated received URL cleanup is idempotent', () => {
  const { lifecycle, revoked } = createHarness();
  const url = lifecycle.install({}, 'once.bin');

  assert.equal(lifecycle.clear(), true);
  assert.equal(lifecycle.clear(), false);
  assert.equal(lifecycle.clear(), false);
  assert.deepEqual(revoked, [url]);
});

test('direct-to-disk completion cannot retain a previous Blob URL', () => {
  const { lifecycle, revoked } = createHarness();
  const url = lifecycle.install({}, 'memory.bin');
  lifecycle.clear();

  assert.deepEqual(revoked, [url]);
  assert.match(appSource, /if \(options\.savedToDisk\) \{\s*receivedBlobUrls\.clear\(\);/);
});

test('cancellation, failure, manual reset, and pagehide use centralized cleanup', () => {
  assert.match(appSource, /webrtcManager\.onTransferError = \([^)]*\) => \{\s*receivedBlobUrls\.clear\(\);/);
  assert.match(appSource, /webrtcManager\.onFileTransferCancelled = \([^)]*\) => \{\s*receivedBlobUrls\.clear\(\);/);
  assert.match(appSource, /btnResetTransfer\.addEventListener\('click', \(\) => \{[\s\S]{0,250}receivedBlobUrls\.clear\(\);/);
  assert.match(appSource, /window\.addEventListener\('pagehide', \(\) => \{\s*receivedBlobUrls\.clear\(\);/);
});
