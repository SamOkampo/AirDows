'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebRTCManager = require('../public/js/webrtc-manager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const manager = new WebRTCManager({});
  const reads = [];
  const reports = [];
  manager.peerConnection = { generation: 'current' };
  manager.getActiveCandidatePairDetails = (peerConnection) => {
    const gate = deferred();
    reads.push({ gate, peerConnection });
    return gate.promise;
  };
  manager.onNetworkDiagnostics = (metrics) => reports.push(metrics);
  return { manager, reads, reports };
}

function startTransfer(manager, options = {}) {
  let bytes = options.bytes || 0;
  manager.startNetworkDiagnostics({
    transferId: options.transferId || 'transfer-a',
    direction: options.direction || 'send',
    fileName: options.fileName || 'file-a.bin',
    totalBytes: options.totalBytes || 100,
    getBytesTransferred: () => bytes
  });
  return {
    context: manager.diagnosticsTransfer,
    setBytes(value) {
      bytes = value;
    }
  };
}

function resolveRead(read, connectionType = 'host') {
  read.gate.resolve({
    connectionType,
    localCandidateType: connectionType,
    remoteCandidateType: connectionType
  });
}

test('stats from transfer A resolving during transfer B are discarded', async () => {
  const { manager, reads, reports } = createHarness();
  startTransfer(manager, {
    transferId: 'transfer-a',
    direction: 'send',
    fileName: 'a.bin',
    totalBytes: 100
  });
  startTransfer(manager, {
    transferId: 'transfer-b',
    direction: 'receive',
    fileName: 'b.bin',
    totalBytes: 200,
    bytes: 50
  });

  resolveRead(reads[1], 'relay');
  await reads[1].gate.promise;
  await new Promise((resolve) => setImmediate(resolve));
  resolveRead(reads[0], 'host');
  await reads[0].gate.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  assert.equal(reports[0].direction, 'receive');
  assert.equal(reports[0].fileName, 'b.bin');
  assert.equal(reports[0].percent, 25);
  assert.equal(reports[0].connectionType, 'relay');
  assert.equal(Object.hasOwn(reports[0], 'transferId'), false);
  manager.stopNetworkDiagnostics();
});

test('a polling result that resolves after diagnostics stop cannot publish', async () => {
  const { manager, reads, reports } = createHarness();
  const transfer = startTransfer(manager);
  const polling = manager.emitNetworkDiagnostics(transfer.context);
  manager.stopNetworkDiagnostics();

  resolveRead(reads[0]);
  resolveRead(reads[1]);
  await Promise.all([polling, new Promise((resolve) => setImmediate(resolve))]);

  assert.deepEqual(reports, []);
  assert.equal(manager.diagnosticsTransfer, null);
  assert.equal(manager.diagnosticsState, null);
});

test('cancelling diagnostics invalidates an in-flight getStats result', async () => {
  const { manager, reads, reports } = createHarness();
  startTransfer(manager, { transferId: 'cancelled-transfer' });
  manager.stopNetworkDiagnostics();
  resolveRead(reads[0]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reports, []);
  assert.equal(manager.lastDiagnosticsBytes, 0);
  assert.equal(manager.lastDiagnosticsTimestamp, 0);
});

test('two consecutive transfers retain independent immutable contexts', async () => {
  const { manager, reads, reports } = createHarness();
  const first = startTransfer(manager, {
    transferId: 'first-transfer',
    direction: 'send',
    fileName: 'first.bin',
    totalBytes: 10
  });
  const second = startTransfer(manager, {
    transferId: 'second-transfer',
    direction: 'receive',
    fileName: 'second.bin',
    totalBytes: 40,
    bytes: 20
  });

  assert.equal(Object.isFrozen(first.context), true);
  assert.equal(Object.isFrozen(second.context), true);
  assert.notEqual(first.context.generation, second.context.generation);
  assert.equal(first.context.transferId, 'first-transfer');
  assert.equal(second.context.transferId, 'second-transfer');

  resolveRead(reads[0], 'host');
  resolveRead(reads[1], 'srflx');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  assert.equal(reports[0].direction, 'receive');
  assert.equal(reports[0].percent, 50);
  manager.stopNetworkDiagnostics();
});

test('a valid current diagnostics result is attributed to its own transfer snapshot', async () => {
  const { manager, reads, reports } = createHarness();
  const transfer = startTransfer(manager, {
    transferId: 'valid-transfer',
    direction: 'send',
    fileName: 'valid.bin',
    totalBytes: 80,
    bytes: 20
  });

  assert.equal(reads[0].peerConnection, transfer.context.peerConnection);
  resolveRead(reads[0], 'host');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  assert.deepEqual(
    {
      direction: reports[0].direction,
      fileName: reports[0].fileName,
      percent: reports[0].percent,
      connectionType: reports[0].connectionType
    },
    {
      direction: 'send',
      fileName: 'valid.bin',
      percent: 25,
      connectionType: 'host'
    }
  );
  assert.equal(manager.lastDiagnosticsMetrics, reports[0]);
  manager.stopNetworkDiagnostics();
});

test('an older overlapping poll cannot overwrite a newer sample in one transfer', async () => {
  const { manager, reads, reports } = createHarness();
  const transfer = startTransfer(manager, { bytes: 10 });
  transfer.setBytes(30);
  const newerPoll = manager.emitNetworkDiagnostics(transfer.context);

  resolveRead(reads[1], 'relay');
  await newerPoll;
  resolveRead(reads[0], 'host');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  assert.equal(reports[0].connectionType, 'relay');
  assert.equal(reports[0].percent, 30);
  manager.stopNetworkDiagnostics();
});
