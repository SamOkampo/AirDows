'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const webrtcPath = path.join(__dirname, '..', 'public', 'js', 'webrtc-manager.js');
const htmlPath = path.join(__dirname, '..', 'public', 'app.html');
const appSource = fs.readFileSync(appPath, 'utf8');
const webrtcSource = fs.readFileSync(webrtcPath, 'utf8');
const htmlSource = fs.readFileSync(htmlPath, 'utf8');

function loadManagerFactory() {
  const startAnchor = 'function createReceivedDownloadsManager';
  const endAnchor = '\nfunction isAutomaticReconnectAllowed';
  const start = appSource.indexOf(startAnchor);
  const end = appSource.indexOf(endAnchor, start);
  assert.notEqual(start, -1, `Missing source anchor: ${startAnchor}`);
  assert.notEqual(end, -1, `Missing source anchor: ${endAnchor}`);
  assert.ok(end > start, 'Received download manager source anchors are out of order');

  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${appSource.slice(start, end)}
this.factory = createReceivedDownloadsManager;
this.clearOnPageHide = clearReceivedDownloadsOnPageHide;`,
    context
  );
  return {
    factory: context.factory,
    clearOnPageHide: context.clearOnPageHide
  };
}

const managerHelpers = loadManagerFactory();

function createHarness() {
  const revoked = [];
  const created = [];
  const scheduled = [];
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
  const manager = managerHelpers.factory(urlApi, (callback, delay) => {
    scheduled.push({ callback, delay });
  });
  const runScheduled = () => {
    while (scheduled.length) scheduled.shift().callback();
  };
  return { manager, created, revoked, scheduled, runScheduled };
}

test('receiving a file does not start an automatic download', () => {
  const { manager, created, revoked, scheduled } = createHarness();

  const item = manager.install({ size: 4 }, 'received.bin');

  assert.equal(item.status, 'ready');
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, []);
  assert.equal(scheduled.length, 0);
  assert.doesNotMatch(
    appSource,
    /btnDownload\.click\s*\(|downloadLink\.click\s*\(|receivedDownloads\.[\w]+\([^)]*\)\.click\s*\(/
  );
});

test('one received file creates one downloadable Blob URL', () => {
  const { manager, created } = createHarness();
  const installed = manager.install({ size: 0 }, 'empty.bin');
  const [pending] = manager.getPendingItems();

  assert.equal(created.length, 1);
  assert.equal(installed.url, 'blob:received-1');
  assert.equal(installed.size, 0);
  assert.deepEqual(pending, installed);
});

test('two files retain independent URLs in reception order', () => {
  const { manager, created, revoked } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  const second = manager.install({ size: 2 }, 'second.bin');

  assert.equal(created.length, 2);
  assert.notEqual(first.url, second.url);
  assert.deepEqual(Array.from(manager.getItems(), (item) => item.fileName), ['first.bin', 'second.bin']);
  assert.deepEqual(Array.from(manager.getPendingItems(), (item) => item.url), [first.url, second.url]);
  assert.deepEqual(revoked, []);
});

test('installing a second file does not revoke the first URL', () => {
  const { manager, revoked } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  manager.install({ size: 2 }, 'second.bin');

  assert.equal(revoked.includes(first.url), false);
  assert.equal(manager.getPendingItems()[0].url, first.url);
});

test('releasing one pending file removes only that file', () => {
  const { manager, revoked } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  const second = manager.install({ size: 2 }, 'second.bin');

  assert.equal(manager.release(first.id), true);
  assert.deepEqual(revoked, [first.url]);
  assert.deepEqual(Array.from(manager.getItems(), (item) => item.id), [second.id]);
  assert.equal(manager.getPendingItems()[0].url, second.url);
});

test('downloading one file revokes only its URL after the download starts', () => {
  const { manager, revoked, scheduled, runScheduled } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  const second = manager.install({ size: 2 }, 'second.bin');

  assert.equal(manager.startDownload(first.id), true);
  assert.deepEqual(revoked, []);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  assert.equal(manager.getItems()[0].status, 'downloaded');

  runScheduled();

  assert.deepEqual(revoked, [first.url]);
  assert.equal(manager.getItems()[0].url, null);
  assert.equal(manager.getPendingItems()[0].url, second.url);
});

test('double click cannot start the same download twice', () => {
  const { manager, revoked, scheduled, runScheduled } = createHarness();
  const item = manager.install({ size: 3 }, 'once.bin');

  assert.equal(manager.startDownload(item.id), true);
  assert.equal(manager.startDownload(item.id), false);
  assert.equal(scheduled.length, 1);
  runScheduled();
  assert.deepEqual(revoked, [item.url]);
});

test('downloading the first file does not invalidate the second', () => {
  const { manager, revoked, runScheduled } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  const second = manager.install({ size: 2 }, 'second.bin');

  manager.startDownload(first.id);
  runScheduled();

  assert.deepEqual(revoked, [first.url]);
  assert.equal(manager.getPendingItems().length, 1);
  assert.equal(manager.getPendingItems()[0].url, second.url);
  assert.equal(manager.startDownload(second.id), true);
});

test('pending item snapshots cannot mutate manager state', () => {
  const { manager } = createHarness();
  manager.install({ size: 5 }, 'immutable.bin');
  const pending = manager.getPendingItems();

  assert.equal(Object.isFrozen(pending), true);
  assert.equal(Object.isFrozen(pending[0]), true);
  assert.throws(() => pending.push({}), (error) => error?.name === 'TypeError');
  assert.throws(
    () => { pending[0].status = 'downloaded'; },
    (error) => error?.name === 'TypeError'
  );
  assert.equal(manager.getPendingItems()[0].status, 'ready');
});

test('full reset releases every received Blob URL', () => {
  const { manager, revoked } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  const second = manager.install({ size: 2 }, 'second.bin');

  assert.equal(manager.clearAll(), 2);
  assert.deepEqual(revoked, [first.url, second.url]);
  assert.equal(manager.getItems().length, 0);
  assert.match(appSource, /function resetApp\([^)]*\) \{\s*clearReceivedDownloads\(\);/);
});

test('non-recoverable disconnect reaches the full received-download reset', () => {
  assert.match(
    appSource,
    /socketManager\.onDisconnect = \([^)]*\) => \{[\s\S]{0,300}if \(recoverable && roomCode\)[\s\S]{0,160}resetApp\(\);/
  );
  assert.match(appSource, /function resetApp\([^)]*\) \{\s*clearReceivedDownloads\(\);/);
});

test('normal pagehide releases all received URLs', () => {
  const { manager, revoked } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  const second = manager.install({ size: 2 }, 'second.bin');

  assert.equal(managerHelpers.clearOnPageHide({ persisted: false }, manager), true);
  assert.deepEqual(revoked, [first.url, second.url]);
  assert.equal(manager.getItems().length, 0);
  assert.match(
    appSource,
    /window\.addEventListener\('pagehide', \(event\) => \{\s*clearReceivedDownloadsOnPageHide\(event, receivedDownloads\);/
  );
});

test('bfcache pagehide preserves every received URL', () => {
  const { manager, revoked } = createHarness();
  const first = manager.install({ size: 1 }, 'first.bin');
  const second = manager.install({ size: 2 }, 'second.bin');

  assert.equal(managerHelpers.clearOnPageHide({ persisted: true }, manager), false);
  assert.deepEqual(revoked, []);
  assert.deepEqual(
    Array.from(manager.getPendingItems(), (item) => item.url),
    [first.url, second.url]
  );
});

test('direct-to-disk completion creates no Blob URL or download control', () => {
  const completionStart = appSource.indexOf('webrtcManager.onFileTransferComplete');
  const diskStart = appSource.indexOf('if (options.savedToDisk)', completionStart);
  const memoryStart = appSource.indexOf('} else if (fileBlob)', diskStart);
  const diskBranch = appSource.slice(diskStart, memoryStart);

  assert.ok(completionStart >= 0 && diskStart > completionStart && memoryStart > diskStart);
  assert.doesNotMatch(diskBranch, /createObjectURL|receivedDownloads\.install|btn_download/);
  assert.match(diskBranch, /completedFileSize\.textContent = translate\('saved_to_disk'\)/);
});

test('delivery ACK remains before UI completion and independent from download clicks', () => {
  const finalizeStart = webrtcSource.indexOf('async finalizeIncomingFile');
  const finalizeEnd = webrtcSource.indexOf('\n  async failIncomingTransfer', finalizeStart);
  const finalizeSource = webrtcSource.slice(finalizeStart, finalizeEnd);
  const ackIndex = finalizeSource.indexOf("type: 'transfer-ack'");
  const completionIndex = finalizeSource.indexOf('this.onFileTransferComplete(fileBlob');

  assert.ok(ackIndex >= 0, 'receiver finalization must emit transfer-ack');
  assert.ok(completionIndex > ackIndex, 'ACK must precede the UI completion callback');
  assert.doesNotMatch(finalizeSource, /startDownload|btnDownload|downloadLink/);
  assert.doesNotMatch(appSource, /sendDeliveryControl\(\{\s*type: 'transfer-ack'/);
});

test('received-download interface includes complete English and Spanish copy', () => {
  const requiredEnglish = [
    'Received files',
    'Ready to download',
    'Download',
    'Downloaded',
    'Download pending files',
    'Transfer Another File'
  ];
  const requiredSpanish = [
    'Archivos recibidos',
    'Listo para descargar',
    'Descargar',
    'Descargado',
    'Descargar archivos pendientes',
    'Transferir otro archivo'
  ];

  for (const text of [...requiredEnglish, ...requiredSpanish]) {
    assert.ok(htmlSource.includes(text), `Missing received-download translation: ${text}`);
  }
  assert.match(htmlSource, /id="received-files-list"[^>]*aria-live="polite"/);
});
