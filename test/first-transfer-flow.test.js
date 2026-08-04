'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const browserSandbox = {
  window: {},
  document: { addEventListener() {} },
  URL
};
vm.runInNewContext(read('public/js/app.js'), browserSandbox);
const flow = browserSandbox.window.FirstTransferFlow;

function createFile(name, size, type = 'application/octet-stream') {
  return { name, size, type };
}

function addFiles(queue, files) {
  let id = queue.length;
  return flow.addPendingFiles(queue, files, (file) => ({ id: ++id, file }));
}

test('choosing Receive opens its panel and automatically requests a room', () => {
  const html = read('public/app.html');
  const app = read('public/js/app.js');

  assert.match(html, /id="btn-role-receive"/);
  assert.match(html, /id="receive-flow"[^>]*hidden/);
  assert.match(app, /btnRoleReceive\.addEventListener\('click',[\s\S]*selectTransferRole\('receive'\)/);
  assert.match(app, /if \(role === 'receive'\) \{[\s\S]*requestPairingCode\(\)/);
  assert.match(app, /socketManager\.onCodeGenerated[\s\S]*codeDisplayWrapper\.classList\.remove\('hidden'\)/);
});

test('choosing Send opens the translated code form', () => {
  const html = read('public/app.html');
  const app = read('public/js/app.js');

  assert.match(html, /id="btn-role-send"/);
  assert.match(html, /id="send-flow"[^>]*hidden[\s\S]*id="join-code-input"/);
  assert.match(app, /btnRoleSend\.addEventListener\('click',[\s\S]*selectTransferRole\('send'\)/);
});

test('selecting a file leaves it pending and cannot start sendFile', () => {
  const queue = [];
  addFiles(queue, [createFile('pending.bin', 8)]);

  assert.equal(queue[0].confirmed, false);
  assert.equal(flow.findNextConfirmedFile(queue), null);
  assert.match(
    read('public/js/app.js'),
    /const nextItem = firstTransferFlow\.findNextConfirmedFile\(transferQueue\);[\s\S]*await webrtcManager\.sendFile/
  );
});

test('removing a selected file prevents it from entering the confirmed queue', () => {
  const queue = [];
  const [item] = addFiles(queue, [createFile('remove-me.bin', 4)]);

  assert.equal(flow.removePendingFile(queue, item.id), true);
  assert.equal(flow.confirmPendingFiles(queue, true).length, 0);
  assert.equal(flow.findNextConfirmedFile(queue), null);
});

test('clearing the selection leaves confirmation disabled', () => {
  const queue = [];
  addFiles(queue, [createFile('a.bin', 1), createFile('b.bin', 2)]);

  assert.equal(flow.clearPendingFiles(queue), 2);
  assert.equal(flow.canConfirmSend(queue, true), false);
  assert.equal(flow.getSelectionSummary(queue).count, 0);
});

test('adding two files preserves their selected order', () => {
  const queue = [];
  addFiles(queue, [createFile('first.bin', 1), createFile('second.bin', 2)]);
  flow.confirmPendingFiles(queue, true);

  assert.deepEqual(queue.map((item) => item.file.name), ['first.bin', 'second.bin']);
  assert.equal(flow.findNextConfirmedFile(queue).file.name, 'first.bin');
  queue[0].status = 'done';
  assert.equal(flow.findNextConfirmedFile(queue).file.name, 'second.bin');
});

test('a second Send click cannot confirm or duplicate the same files', () => {
  const queue = [];
  addFiles(queue, [createFile('once.bin', 3)]);

  assert.equal(flow.confirmPendingFiles(queue, true).length, 1);
  assert.equal(flow.confirmPendingFiles(queue, true).length, 0);
  assert.equal(queue.filter((item) => item.confirmed).length, 1);
});

test('sending becomes possible only after connection and explicit confirmation', () => {
  const queue = [];
  addFiles(queue, [createFile('gated.bin', 3)]);

  assert.equal(flow.canConfirmSend(queue, false), false);
  assert.equal(flow.confirmPendingFiles(queue, false).length, 0);
  assert.equal(flow.findNextConfirmedFile(queue), null);
  assert.equal(flow.canConfirmSend(queue, true), true);
  flow.confirmPendingFiles(queue, true);
  assert.equal(flow.findNextConfirmedFile(queue).file.name, 'gated.bin');
});

test('sender success remains downstream of the delivery ACK', () => {
  const app = read('public/js/app.js');
  const webrtc = read('public/js/webrtc-manager.js');

  assert.match(app, /await webrtcManager\.sendFile\([\s\S]*nextItem\.status = 'done'/);
  assert.match(
    webrtc,
    /await deliveryPromise;[\s\S]*this\.onFileTransferComplete\(null, file\.name/
  );
});

test('zero-byte files remain valid pending and confirmed items', () => {
  const queue = [];
  addFiles(queue, [createFile('empty.txt', 0, 'text/plain')]);

  const summary = flow.getSelectionSummary(queue);
  assert.equal(summary.count, 1);
  assert.equal(summary.totalBytes, 0);
  assert.equal(flow.confirmPendingFiles(queue, true).length, 1);
  assert.equal(flow.findNextConfirmedFile(queue).file.size, 0);
});

test('clipboard sending remains independent from the pending file selection', () => {
  const app = read('public/js/app.js');
  const handler = app.match(/btnSendText\.addEventListener\('click',[\s\S]*?\n  \}\);/);

  assert.ok(handler);
  assert.match(handler[0], /webrtcManager\.sendClipboardText\(text\)/);
  assert.doesNotMatch(handler[0], /transferQueue|confirmPendingSelection|processQueue/);
});

test('essential first-transfer copy exists in complete English and Spanish dictionaries', () => {
  const html = read('public/app.html');
  const keys = [
    'role_send',
    'role_receive',
    'waiting_other_device',
    'devices_connected',
    'files_ready_to_send',
    'status_sending',
    'status_transfer_completed',
    'status_transfer_interrupted',
    'try_again',
    'btn_clear_selection',
    'btn_send_files'
  ];

  for (const key of keys) {
    const matches = html.match(new RegExp(`\\b${key}:`, 'g')) || [];
    assert.equal(matches.length, 2, `${key} must exist in English and Spanish`);
  }
});
