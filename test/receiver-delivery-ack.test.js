'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebRTCManager = require('../public/js/webrtc-manager');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeDataChannel {
  constructor(onSend = null) {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'arraybuffer';
    this.sent = [];
    this.onSend = onSend;
    this.listeners = new Map();
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('Data channel is closed.');
    this.sent.push(data);
    if (this.onSend) this.onSend(data);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
    this.emit('close');
  }
}

function createManager(options = {}) {
  const manager = new WebRTCManager({}, {
    deliveryAckTimeout: options.deliveryAckTimeout || 100,
    deliveryAckRetryInterval: options.deliveryAckRetryInterval || 20,
    deliveryAckCooldown: options.deliveryAckCooldown || 2,
    deliveryAckNow: options.deliveryAckNow
  });
  manager.selectPerformanceProfile = async () => ({
    chunkSize: 4,
    bufferThreshold: 1024,
    lowThreshold: 0,
    label: 'test',
    connectionType: 'host'
  });
  manager.waitForEncryption = async () => null;
  manager.startNetworkDiagnostics = () => {};
  manager.stopNetworkDiagnostics = () => {};
  manager.flushRelayUsage = () => {};
  manager.reportTransferError = () => {};
  return manager;
}

function createFile(bytes = [1, 2, 3], name = 'test.bin') {
  const file = new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' });
  Object.defineProperty(file, 'name', { value: name });
  return file;
}

function controlMessages(channel, type = null) {
  return channel.sent
    .filter((item) => typeof item === 'string')
    .map((item) => JSON.parse(item))
    .filter((message) => !type || message.type === type);
}

async function waitForControl(channel, type) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = controlMessages(channel, type)[0];
    if (message) return message;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function startSender(options = {}) {
  const manager = createManager(options);
  const channel = new FakeDataChannel((data) => {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data);
    if (message.type === 'metadata') {
      setImmediate(() => manager.handleIncomingTextMessage(JSON.stringify({
        type: 'receiver-ready',
        transferId: message.transferId,
        offset: options.resumeOffset || 0,
        size: message.size
      })));
    }
  });
  manager.setDataChannel(channel);
  const file = options.file || createFile();
  const transferId = options.transferId || 'transfer-test';
  const promise = manager.sendFile(file, { transferId });
  return { manager, channel, file, transferId, promise };
}

function prepareReceiver(options = {}) {
  const manager = createManager(options.managerOptions || {});
  const channel = new FakeDataChannel();
  manager.setDataChannel(channel);
  const size = options.size ?? 3;
  const transferId = options.transferId || 'receiver-transfer';
  const state = manager.createEmptyReceiverState();
  state.metadata = {
    type: 'metadata',
    name: 'received.bin',
    size,
    mime: 'application/octet-stream',
    transferId,
    encryption: null
  };
  state.receivedSize = options.receivedSize ?? size;
  state.receivedBuffers = options.receivedBuffers || (size ? [Uint8Array.from([1, 2, 3]).slice(0, size)] : []);
  state.writeMode = options.writeMode || 'memory';
  state.writable = options.writable || null;
  state.writeChain = options.writeChain || Promise.resolve();
  state.writeFailed = Boolean(options.writeFailed);
  manager.receiverState = state;
  return { manager, channel, state, transferId, size };
}

function sendFinished(manager, transferId, size) {
  return manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-finished',
    transferId,
    size
  }));
}

test('sender does not complete immediately after the final chunk', async () => {
  const { channel, promise } = startSender();
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  const finished = await waitForControl(channel, 'transfer-finished');
  assert.deepEqual(finished, {
    type: 'transfer-finished',
    transferId: 'transfer-test',
    size: 3
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  channel.close();
  await assert.rejects(promise);
});

test('sender completes after one matching transfer-ack', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  await waitForControl(channel, 'transfer-finished');
  await manager.handleIncomingTextMessage(JSON.stringify({ type: 'transfer-ack', transferId, size: file.size }));
  await promise;
});

test('sender retries transfer-finished when the first delivery ACK is lost', async () => {
  const { manager, channel, file, transferId, promise } = startSender({
    deliveryAckTimeout: 100,
    deliveryAckRetryInterval: 5
  });
  await waitForControl(channel, 'transfer-finished');

  while (controlMessages(channel, 'transfer-finished').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size });
  await promise;
  assert.equal(controlMessages(channel, 'transfer-finished').length >= 2, true);
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('transfer-finished retry waits for DataChannel backpressure', async () => {
  const { manager, channel, file, transferId, promise } = startSender({
    deliveryAckTimeout: 200,
    deliveryAckRetryInterval: 5
  });
  await waitForControl(channel, 'transfer-finished');
  channel.bufferedAmount = 1024;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (channel.listeners.get('bufferedamountlow')?.size) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(channel.listeners.get('bufferedamountlow')?.size > 0, true);
  assert.equal(controlMessages(channel, 'transfer-finished').length, 1);
  channel.bufferedAmount = 0;
  channel.emit('bufferedamountlow');

  while (controlMessages(channel, 'transfer-finished').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size });
  await promise;
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('lost first ACK after receiver finalization is recovered without duplicate completion', async () => {
  const sender = createManager({
    deliveryAckTimeout: 200,
    deliveryAckRetryInterval: 5
  });
  const receiver = createManager();
  let droppedAcks = 0;
  let senderCompletions = 0;
  let receiverCompletions = 0;
  let receiverChannel;

  const senderChannel = new FakeDataChannel((data) => {
    const incoming = ArrayBuffer.isView(data)
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data;
    setImmediate(() => receiverChannel.onmessage({ data: incoming }));
  });
  receiverChannel = new FakeDataChannel((data) => {
    if (typeof data === 'string' && JSON.parse(data).type === 'transfer-ack' && droppedAcks === 0) {
      droppedAcks += 1;
      return;
    }
    setImmediate(() => senderChannel.onmessage({ data }));
  });

  sender.setDataChannel(senderChannel);
  receiver.setDataChannel(receiverChannel);
  sender.onFileTransferComplete = () => { senderCompletions += 1; };
  receiver.onFileTransferComplete = () => { receiverCompletions += 1; };

  await sender.sendFile(createFile(), { transferId: 'lost-first-ack' });

  assert.equal(droppedAcks, 1);
  assert.equal(senderCompletions, 1);
  assert.equal(receiverCompletions, 1);
  assert.equal(controlMessages(receiverChannel, 'transfer-ack').length, 2);
  assert.equal(sender.deliveryWaiters.size, 0);
});

test('matching ACK cancels delivery timeout and further terminal retries', async () => {
  const { manager, channel, file, transferId, promise } = startSender({
    deliveryAckTimeout: 50,
    deliveryAckRetryInterval: 5
  });
  await waitForControl(channel, 'transfer-finished');
  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size });
  await promise;
  const terminalCount = controlMessages(channel, 'transfer-finished').length;

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(controlMessages(channel, 'transfer-finished').length, terminalCount);
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('sender onFileTransferComplete runs only after ACK', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await waitForControl(channel, 'transfer-finished');
  assert.equal(completions, 0);
  await manager.handleIncomingTextMessage(JSON.stringify({ type: 'transfer-ack', transferId, size: file.size }));
  await promise;
  assert.equal(completions, 1);
});

test('queue status cannot become done before sendFile receives ACK', () => {
  const app = read('public/js/app.js');
  assert.match(app, /await webrtcManager\.sendFile\([\s\S]*nextItem\.status = 'done'/);
});

test('ACK for another transferId is ignored', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  await waitForControl(channel, 'transfer-finished');
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId: 'other-transfer', size: file.size }), false);
  assert.equal(manager.deliveryWaiters.size, 1);
  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size });
  await promise;
});

test('ACK with the wrong size cannot complete a transfer', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  await waitForControl(channel, 'transfer-finished');
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size + 1 }), false);
  assert.equal(manager.deliveryWaiters.size, 1);
  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size });
  await promise;
});

test('malformed ACK and failure messages cannot settle a delivery waiter', async () => {
  const manager = createManager();
  const promise = manager.createDeliveryWaiter('validated-transfer', 3);
  promise.catch(() => {});

  assert.equal(manager.handleTransferAck({
    type: 'transfer-ack', transferId: 'validated-transfer', size: 3, extra: 'not-allowed'
  }), false);
  assert.equal(manager.handleTransferAck({
    type: 'transfer-ack', transferId: '', size: 3
  }), false);
  assert.equal(manager.handleTransferFailed({
    type: 'transfer-failed', transferId: 'validated-transfer', reason: 'PRIVATE_DETAILS'
  }), false);
  assert.equal(manager.deliveryWaiters.size, 1);

  manager.handleTransferAck({ type: 'transfer-ack', transferId: 'validated-transfer', size: 3 });
  await promise;
});

test('duplicate ACK does not complete twice', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await waitForControl(channel, 'transfer-finished');
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size }), true);
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size }), false);
  await promise;
  assert.equal(completions, 1);
});

test('late ACK after cancellation is ignored', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  await waitForControl(channel, 'transfer-finished');
  manager.cancelActiveTransfer();
  await assert.rejects(promise, { name: 'TransferCancelledError' });
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size }), false);
});

test('late ACK after timeout is ignored', async () => {
  const manager = createManager({ deliveryAckTimeout: 5 });
  const promise = manager.createDeliveryWaiter('late-timeout', 1);
  await assert.rejects(promise, { code: 'DELIVERY_ACK_TIMEOUT' });
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId: 'late-timeout', size: 1 }), false);
});

test('ACK timeout rejects sendFile with DELIVERY_ACK_TIMEOUT', async () => {
  const { manager, channel, file, transferId, promise } = startSender({ deliveryAckTimeout: 5 });
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await waitForControl(channel, 'transfer-finished');
  const transfer = manager.activeSendTransfer;
  await assert.rejects(promise, { code: 'DELIVERY_ACK_TIMEOUT' });
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size }), false);
  assert.equal(transfer.terminalState, 'failed');
  assert.equal(completions, 0);
});

test('transfer-failed rejects with DELIVERY_REJECTED', async () => {
  const { manager, channel, transferId, promise } = startSender();
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await waitForControl(channel, 'transfer-finished');
  manager.handleTransferFailed({ type: 'transfer-failed', transferId, reason: 'WRITE_FAILED' });
  await assert.rejects(promise, { code: 'DELIVERY_REJECTED', reason: 'WRITE_FAILED' });
  assert.equal(completions, 0);
});

test('data-channel closure rejects a pending ACK immediately', async () => {
  const { channel, promise } = startSender({ deliveryAckTimeout: 1000 });
  await waitForControl(channel, 'transfer-finished');
  channel.close();
  await assert.rejects(promise, { code: 'DATA_CHANNEL_CLOSED' });
});

test('data-channel error followed by close disconnects and rejects waiters exactly once', async () => {
  const manager = createManager({ deliveryAckTimeout: 1000 });
  const channel = new FakeDataChannel();
  const states = [];
  const rejectionCodes = [];
  const rejectAllDeliveryWaiters = manager.rejectAllDeliveryWaiters.bind(manager);
  manager.onConnectionStateChange = (state) => states.push(state);
  manager.rejectAllDeliveryWaiters = (code, message) => {
    rejectionCodes.push(code);
    return rejectAllDeliveryWaiters(code, message);
  };
  manager.setDataChannel(channel);
  const waiter = manager.createDeliveryWaiter('error-then-close', 1);

  channel.onerror(new Error('synthetic channel error'));
  channel.close();

  await assert.rejects(waiter, { code: 'DATA_CHANNEL_ERROR' });
  assert.deepEqual(states, ['disconnected']);
  assert.deepEqual(rejectionCodes, ['DATA_CHANNEL_ERROR']);
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('throwing disconnection callback cannot interrupt terminal cleanup or waiter rejection', async () => {
  const manager = createManager({ deliveryAckTimeout: 1000 });
  const channel = new FakeDataChannel();
  const rejectionCodes = [];
  let notifications = 0;
  let diagnosticsStops = 0;
  let receiverCleanups = 0;
  const rejectAllDeliveryWaiters = manager.rejectAllDeliveryWaiters.bind(manager);
  manager.onConnectionStateChange = () => {
    notifications += 1;
    throw new Error('synthetic UI callback failure');
  };
  manager.stopNetworkDiagnostics = () => {
    diagnosticsStops += 1;
  };
  manager.cleanupReceiverDiskStream = async () => {
    receiverCleanups += 1;
  };
  manager.rejectAllDeliveryWaiters = (code, message) => {
    rejectionCodes.push(code);
    return rejectAllDeliveryWaiters(code, message);
  };
  manager.setDataChannel(channel);
  const waiter = manager.createDeliveryWaiter('throwing-disconnect-callback', 1);

  assert.doesNotThrow(() => channel.onerror(new Error('synthetic channel error')));
  channel.onclose();

  await assert.rejects(waiter, { code: 'DATA_CHANNEL_ERROR' });
  assert.equal(notifications, 1);
  assert.equal(diagnosticsStops, 1);
  assert.equal(receiverCleanups, 1);
  assert.deepEqual(rejectionCodes, ['DATA_CHANNEL_ERROR']);
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('data-channel close followed by error keeps the close as the only terminal event', async () => {
  const manager = createManager({ deliveryAckTimeout: 1000 });
  const channel = new FakeDataChannel();
  const states = [];
  const rejectionCodes = [];
  const rejectAllDeliveryWaiters = manager.rejectAllDeliveryWaiters.bind(manager);
  manager.onConnectionStateChange = (state) => states.push(state);
  manager.rejectAllDeliveryWaiters = (code, message) => {
    rejectionCodes.push(code);
    return rejectAllDeliveryWaiters(code, message);
  };
  manager.setDataChannel(channel);
  const waiter = manager.createDeliveryWaiter('close-then-error', 1);

  channel.close();
  channel.onerror(new Error('late synthetic channel error'));

  await assert.rejects(waiter, { code: 'DATA_CHANNEL_CLOSED' });
  assert.deepEqual(states, ['disconnected']);
  assert.deepEqual(rejectionCodes, ['DATA_CHANNEL_CLOSED']);
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('duplicate data-channel terminal events remain idempotent', () => {
  const manager = createManager();
  const channel = new FakeDataChannel();
  const states = [];
  const rejectionCodes = [];
  manager.onConnectionStateChange = (state) => states.push(state);
  manager.rejectAllDeliveryWaiters = (code) => {
    rejectionCodes.push(code);
  };
  manager.setDataChannel(channel);

  channel.onerror(new Error('first synthetic channel error'));
  channel.onerror(new Error('duplicate synthetic channel error'));
  channel.onclose();
  channel.onclose();

  assert.deepEqual(states, ['disconnected']);
  assert.deepEqual(rejectionCodes, ['DATA_CHANNEL_ERROR']);
});

test('obsolete channel terminal events are ignored while the current channel closes normally', () => {
  const manager = createManager();
  const oldChannel = new FakeDataChannel();
  const currentChannel = new FakeDataChannel();
  const states = [];
  const rejectionCodes = [];
  manager.onConnectionStateChange = (state) => states.push(state);
  manager.setDataChannel(oldChannel);
  manager.setDataChannel(currentChannel);
  manager.rejectAllDeliveryWaiters = (code) => {
    rejectionCodes.push(code);
  };

  oldChannel.onerror(new Error('obsolete synthetic channel error'));
  oldChannel.onclose();
  assert.deepEqual(states, []);
  assert.deepEqual(rejectionCodes, []);

  currentChannel.close();
  currentChannel.onerror(new Error('late current channel error'));
  assert.deepEqual(states, ['disconnected']);
  assert.deepEqual(rejectionCodes, ['DATA_CHANNEL_CLOSED']);
});

test('WebRTCManager.close clears ACK waiters and timers', async () => {
  const manager = createManager({ deliveryAckTimeout: 1000 });
  const channel = new FakeDataChannel();
  manager.setDataChannel(channel);
  const promise = manager.createDeliveryWaiter('close-test', 1);
  manager.close();
  await assert.rejects(promise, { code: 'WEBRTC_CLOSED' });
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('replacing a data channel rejects obsolete ACK waiters', async () => {
  const manager = createManager({ deliveryAckTimeout: 1000 });
  manager.setDataChannel(new FakeDataChannel());
  const promise = manager.createDeliveryWaiter('reconnect-test', 1);
  manager.setDataChannel(new FakeDataChannel());
  await assert.rejects(promise, { code: 'DATA_CHANNEL_REPLACED' });
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('local cancellation while awaiting ACK rejects immediately', async () => {
  const { manager, channel, promise } = startSender({ deliveryAckTimeout: 1000 });
  await waitForControl(channel, 'transfer-finished');
  assert.equal(manager.cancelActiveTransfer(), true);
  await assert.rejects(promise, { name: 'TransferCancelledError' });
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('receiver sends ACK only after exact byte validation', async () => {
  const { manager, channel, transferId, size } = prepareReceiver();
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await sendFinished(manager, transferId, size);
  assert.deepEqual(controlMessages(channel, 'transfer-ack'), [
    { type: 'transfer-ack', transferId, size }
  ]);
  assert.equal(completions, 1);
});

test('receiver finalization still cleans up if ACK transmission races channel closure', async () => {
  const { manager, channel, transferId, size } = prepareReceiver();
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  channel.send = () => { throw new Error('channel closed during send'); };
  await sendFinished(manager, transferId, size);
  assert.equal(completions, 1);
  assert.equal(manager.receiverState.metadata, null);
});

test('receiver does not ACK before the disk write chain completes', async () => {
  const writes = deferred();
  const writable = { close: async () => {}, abort: async () => {} };
  const { manager, channel, transferId, size } = prepareReceiver({
    writeMode: 'disk', writable, writeChain: writes.promise
  });
  const finalization = sendFinished(manager, transferId, size);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  writes.resolve();
  await finalization;
  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);
});

test('receiver does not ACK before writable.close succeeds', async () => {
  const closing = deferred();
  const writable = { close: () => closing.promise, abort: async () => {} };
  const { manager, channel, state, transferId, size } = prepareReceiver({ writeMode: 'disk', writable });
  const finalization = sendFinished(manager, transferId, size);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  closing.resolve();
  await finalization;
  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);
});

test('disk close failure sends transfer-failed and no ACK', async () => {
  const writable = {
    close: async () => { throw new Error('close failed'); },
    abort: async () => {}
  };
  const { manager, channel, state, transferId, size } = prepareReceiver({ writeMode: 'disk', writable });
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  assert.equal(controlMessages(channel, 'transfer-failed')[0].reason, 'FINALIZATION_FAILED');
});

test('missing disk writable sends transfer-failed and no ACK', async () => {
  const { manager, channel, transferId, size } = prepareReceiver({ writeMode: 'disk' });
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  assert.equal(controlMessages(channel, 'transfer-failed')[0].reason, 'FINALIZATION_FAILED');
});

test('disk write failure sends transfer-failed and no ACK', async () => {
  const writable = {
    write: async () => { throw new Error('write failed'); },
    close: async () => {},
    abort: async () => {}
  };
  const { manager, channel, state } = prepareReceiver({
    size: 1,
    receivedSize: 0,
    receivedBuffers: [],
    writeMode: 'disk',
    writable
  });
  await manager.enqueueIncomingMessage(Uint8Array.from([1]).buffer);
  assert.equal(state.writeFailed, true);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  assert.equal(controlMessages(channel, 'transfer-failed')[0].reason, 'WRITE_FAILED');
});

test('memory Blob finalization ACKs only when Blob.size matches', async () => {
  const { manager, channel, transferId, size } = prepareReceiver();
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack')[0].size, size);
  assert.equal(controlMessages(channel, 'transfer-failed').length, 0);
});

test('size mismatch sends transfer-failed and no ACK', async () => {
  const { manager, channel, transferId, size } = prepareReceiver({ receivedSize: 2 });
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  assert.equal(controlMessages(channel, 'transfer-failed')[0].reason, 'SIZE_MISMATCH');
});

test('zero-byte memory transfer completes with ACK', async () => {
  const { manager, channel, transferId } = prepareReceiver({ size: 0, receivedSize: 0, receivedBuffers: [] });
  await sendFinished(manager, transferId, 0);
  assert.deepEqual(controlMessages(channel, 'transfer-ack')[0], {
    type: 'transfer-ack', transferId, size: 0
  });
});

test('zero-byte sender emits transfer-finished and completes after ACK', async () => {
  const file = createFile([]);
  const { manager, channel, transferId, promise } = startSender({ file });
  const finished = await waitForControl(channel, 'transfer-finished');
  assert.equal(finished.size, 0);
  assert.equal(channel.sent.some((message) => typeof message !== 'string'), false);
  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: 0 });
  await promise;
});

test('zero-byte disk transfer completes with ACK', async () => {
  let closed = false;
  const writable = { close: async () => { closed = true; }, abort: async () => {} };
  const { manager, channel, transferId } = prepareReceiver({
    size: 0, receivedSize: 0, receivedBuffers: [], writeMode: 'disk', writable
  });
  await sendFinished(manager, transferId, 0);
  assert.equal(closed, true);
  assert.equal(controlMessages(channel, 'transfer-ack')[0].size, 0);
});

test('transfer-finished for a stale transferId is ignored', async () => {
  const { manager, channel, size } = prepareReceiver();
  await sendFinished(manager, 'stale-transfer', size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  assert.equal(controlMessages(channel, 'transfer-failed').length, 0);
});

test('transfer-cancelled for another transferId is ignored', async () => {
  const { manager, channel, state } = prepareReceiver();
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-cancelled', transferId: 'another-transfer'
  }));
  assert.equal(manager.receiverState, state);
  assert.equal(controlMessages(channel, 'transfer-failed').length, 0);
});

test('incoming asynchronous messages are processed serially', async () => {
  const manager = createManager();
  const first = deferred();
  const order = [];
  manager.handleIncomingMessage = async (value) => {
    order.push(`start-${value}`);
    if (value === 'first') await first.promise;
    order.push(`end-${value}`);
  };
  const firstTask = manager.enqueueIncomingMessage('first');
  const secondTask = manager.enqueueIncomingMessage('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start-first']);
  first.resolve();
  await Promise.all([firstTask, secondTask]);
  assert.deepEqual(order, ['start-first', 'end-first', 'start-second', 'end-second']);
});

test('a rejected incoming handler does not poison the message queue', async () => {
  const manager = createManager();
  const processed = [];
  manager.handleIncomingMessage = async (value) => {
    if (value === 'bad') throw new Error('bad message');
    processed.push(value);
  };
  await manager.enqueueIncomingMessage('bad');
  await manager.enqueueIncomingMessage('good');
  assert.deepEqual(processed, ['good']);
});

test('a delayed final chunk finishes before transfer-finished is handled', async () => {
  const decrypted = deferred();
  const { manager, channel, state, transferId } = prepareReceiver({
    size: 1, receivedSize: 0, receivedBuffers: []
  });
  state.metadata.encryption = 'aes-gcm-256';
  manager.decryptChunk = () => decrypted.promise;
  channel.onmessage({ data: Uint8Array.from([9]).buffer });
  channel.onmessage({ data: JSON.stringify({ type: 'transfer-finished', transferId, size: 1 }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  decrypted.resolve(Uint8Array.from([9]).buffer);
  await manager.incomingMessageChain;
  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);
});

test('resume offset behavior remains compatible with the same transferId', async () => {
  const { manager, channel, state, transferId, size } = prepareReceiver({
    size: 3, receivedSize: 2, receivedBuffers: [Uint8Array.from([1, 2])]
  });
  await manager.prepareIncomingFile({ ...state.metadata });
  manager.sendReceiverReady(transferId);
  const ready = controlMessages(channel, 'receiver-ready')[0];
  assert.equal(ready.transferId, transferId);
  assert.equal(ready.offset, 2);
  assert.equal(ready.size, size);
  assert.equal(manager.receiverState, state);
});

test('analytics and logs do not contain transferId values', () => {
  const app = read('public/js/app.js');
  const managerSource = read('public/js/webrtc-manager.js');
  const analyticsCalls = [...app.matchAll(/trackAnalytics\([\s\S]*?\);/g)].map((match) => match[0]);
  const logLines = managerSource.split(/\r?\n/).filter((line) => /console\.(?:log|info|warn|error)/.test(line));
  assert.equal(analyticsCalls.some((call) => /transferId/.test(call)), false);
  assert.equal(logLines.some((line) => /transferId/.test(line)), false);
});

test('ACK followed by transfer-failed produces success only', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  const calls = { completed: 0, failed: 0, cancelled: 0 };
  manager.onFileTransferComplete = () => { calls.completed += 1; };
  manager.reportTransferError = () => { calls.failed += 1; };
  manager.onFileTransferCancelled = () => { calls.cancelled += 1; };
  await waitForControl(channel, 'transfer-finished');
  const transfer = manager.activeSendTransfer;
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size }), true);
  assert.equal(manager.handleTransferFailed({ type: 'transfer-failed', transferId, reason: 'WRITE_FAILED' }), false);
  await promise;
  assert.deepEqual(calls, { completed: 1, failed: 0, cancelled: 0 });
  assert.equal(transfer.terminalState, 'completed');
});

test('transfer-failed followed by ACK cannot complete', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  const calls = { completed: 0, failed: 0 };
  manager.reportTransferError = () => { calls.failed += 1; };
  manager.onFileTransferComplete = () => { calls.completed += 1; };
  await waitForControl(channel, 'transfer-finished');
  const transfer = manager.activeSendTransfer;
  assert.equal(manager.handleTransferFailed({ type: 'transfer-failed', transferId, reason: 'WRITE_FAILED' }), true);
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size }), false);
  await assert.rejects(promise, { code: 'DELIVERY_REJECTED' });
  assert.deepEqual(calls, { completed: 0, failed: 1 });
  assert.equal(transfer.terminalState, 'failed');
});

test('cancellation followed by ACK cannot complete', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  const calls = { completed: 0, cancelled: 0 };
  manager.onFileTransferComplete = () => { calls.completed += 1; };
  manager.onFileTransferCancelled = () => { calls.cancelled += 1; };
  await waitForControl(channel, 'transfer-finished');
  const transfer = manager.activeSendTransfer;
  assert.equal(manager.cancelActiveTransfer(), true);
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size }), false);
  await assert.rejects(promise, { name: 'TransferCancelledError' });
  assert.deepEqual(calls, { completed: 0, cancelled: 1 });
  assert.equal(transfer.terminalState, 'cancelled');
});

test('ACK followed by cancellation cannot cancel a completed transfer', async () => {
  const { manager, channel, file, transferId, promise } = startSender();
  const calls = { completed: 0, cancelled: 0 };
  manager.onFileTransferComplete = () => { calls.completed += 1; };
  manager.onFileTransferCancelled = () => { calls.cancelled += 1; };
  await waitForControl(channel, 'transfer-finished');
  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size });
  assert.equal(manager.cancelActiveTransfer(), false);
  await promise;
  assert.deepEqual(calls, { completed: 1, cancelled: 0 });
});

test('data-channel close racing with ACK settles exactly once', async () => {
  const first = startSender({ deliveryAckTimeout: 1000, transferId: 'ack-wins' });
  await waitForControl(first.channel, 'transfer-finished');
  first.manager.handleTransferAck({ type: 'transfer-ack', transferId: first.transferId, size: first.file.size });
  first.channel.close();
  await first.promise;
  assert.equal(first.manager.deliveryWaiters.size, 0);

  const second = startSender({ deliveryAckTimeout: 1000, transferId: 'close-wins' });
  await waitForControl(second.channel, 'transfer-finished');
  second.channel.close();
  assert.equal(second.manager.handleTransferAck({
    type: 'transfer-ack', transferId: second.transferId, size: second.file.size
  }), false);
  await assert.rejects(second.promise, { code: 'DATA_CHANNEL_CLOSED' });
  assert.equal(second.manager.deliveryWaiters.size, 0);
});

test('receiver finalization error cannot also invoke successful completion', async () => {
  const writable = { close: async () => { throw new Error('close failed'); }, abort: async () => {} };
  const { manager, channel, state, transferId, size } = prepareReceiver({ writeMode: 'disk', writable });
  const calls = { completed: 0, failed: 0 };
  manager.onFileTransferComplete = () => { calls.completed += 1; };
  manager.reportTransferError = () => { calls.failed += 1; };
  await sendFinished(manager, transferId, size);
  assert.deepEqual(calls, { completed: 0, failed: 1 });
  assert.equal(controlMessages(channel, 'transfer-ack').length, 0);
  assert.equal(state.terminalState, 'failed');
});

test('duplicate transfer-finished messages finalize only once', async () => {
  const { manager, channel, state, transferId, size } = prepareReceiver();
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await sendFinished(manager, transferId, size);
  await sendFinished(manager, transferId, size);
  assert.equal(completions, 1);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);
  assert.equal(state.terminalState, 'completed');
});

test('completed transfer re-ACK is limited by a per-transfer cooldown', async () => {
  let now = 1000;
  const { manager, channel, transferId, size } = prepareReceiver({
    managerOptions: {
      deliveryAckCooldown: 100,
      deliveryAckNow: () => now
    }
  });
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await sendFinished(manager, transferId, size);

  for (let index = 0; index < 20; index += 1) {
    await sendFinished(manager, transferId, size);
  }
  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);

  now += 100;
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 2);
  assert.equal(completions, 1);
});

test('malicious duplicate terminals cannot amplify ACKs or repeat completion', async () => {
  let now = 2000;
  const { manager, channel, transferId, size } = prepareReceiver({
    managerOptions: {
      deliveryAckCooldown: 100,
      deliveryAckNow: () => now
    }
  });
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  await sendFinished(manager, transferId, size);

  for (let index = 0; index < 100; index += 1) {
    await sendFinished(manager, transferId, size);
    await sendFinished(manager, transferId, size + 1);
    await sendFinished(manager, `unknown-${index}`, size);
  }

  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);
  assert.equal(completions, 1);
  assert.equal(manager.completedTransfers.size, 1);

  now += 100;
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 2);
});

test('ACK send failure after successful disk close preserves receiver completion truth', async () => {
  let closed = false;
  const writable = { close: async () => { closed = true; }, abort: async () => {} };
  const { manager, channel, state, transferId, size } = prepareReceiver({ writeMode: 'disk', writable });
  let completions = 0;
  let failures = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  manager.reportTransferError = () => { failures += 1; };
  channel.send = () => { throw new Error('ACK send failed'); };
  await sendFinished(manager, transferId, size);
  assert.equal(closed, true);
  assert.equal(completions, 1);
  assert.equal(failures, 0);
  assert.equal(manager.receiverState.metadata, null);
  assert.equal(state.terminalState, 'completed');
});

test('receiver completion callback exception is isolated after Blob finalization', async () => {
  const { manager, channel, state, transferId, size } = prepareReceiver();
  let failures = 0;
  manager.onFileTransferComplete = () => { throw new Error('UI callback failed'); };
  manager.reportTransferError = () => { failures += 1; };
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);
  assert.equal(controlMessages(channel, 'transfer-failed').length, 0);
  assert.equal(failures, 0);
  assert.equal(manager.receiverState.metadata, null);
  assert.equal(state.terminalState, 'completed');
});

test('two sequential transfers with identical names remain isolated on one channel', async () => {
  const manager = createManager();
  const channel = new FakeDataChannel((data) => {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data);
    if (message.type === 'metadata') {
      setImmediate(() => manager.handleIncomingTextMessage(JSON.stringify({
        type: 'receiver-ready', transferId: message.transferId, offset: 0, size: message.size
      })));
    }
  });
  manager.setDataChannel(channel);
  const file = createFile([1, 2, 3], 'same-name.bin');

  const first = manager.sendFile(file, { transferId: 'sequential-a' });
  await waitForControl(channel, 'transfer-finished');
  manager.handleTransferAck({ type: 'transfer-ack', transferId: 'sequential-a', size: file.size });
  await first;
  assert.equal(manager.deliveryWaiters.size, 0);

  const second = manager.sendFile(file, { transferId: 'sequential-b' });
  while (controlMessages(channel, 'transfer-finished').length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId: 'sequential-a', size: file.size }), false);
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-cancelled', transferId: 'sequential-a'
  }));
  assert.equal(manager.activeSendTransfer.transferId, 'sequential-b');
  assert.equal(manager.activeSendTransfer.cancelled, false);
  manager.handleTransferAck({ type: 'transfer-ack', transferId: 'sequential-b', size: file.size });
  await second;
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('receiver clears transfer A before accepting and completing transfer B', async () => {
  const manager = createManager();
  const channel = new FakeDataChannel();
  manager.setDataChannel(channel);
  const metadata = (transferId) => ({
    type: 'metadata', name: 'same-name.bin', size: 1, mime: 'application/octet-stream',
    transferId, encryption: null
  });

  await manager.handleIncomingTextMessage(JSON.stringify(metadata('receiver-a')));
  await manager.handleIncomingFileChunk(Uint8Array.from([1]).buffer);
  await sendFinished(manager, 'receiver-a', 1);
  assert.equal(manager.receiverState.metadata, null);

  await manager.handleIncomingTextMessage(JSON.stringify(metadata('receiver-b')));
  assert.equal(manager.receiverState.metadata.transferId, 'receiver-b');
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-finished', transferId: 'receiver-a', size: 1
  }));
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-cancelled', transferId: 'receiver-a'
  }));
  assert.equal(manager.receiverState.metadata.transferId, 'receiver-b');
  await manager.handleIncomingFileChunk(Uint8Array.from([2]).buffer);
  await sendFinished(manager, 'receiver-b', 1);
  assert.deepEqual(controlMessages(channel, 'transfer-ack').map((message) => message.transferId), [
    'receiver-a', 'receiver-b'
  ]);
});

test('failed transfer A is cleaned before successful transfer B without reconnecting', async () => {
  const manager = createManager();
  const channel = new FakeDataChannel();
  manager.setDataChannel(channel);
  const metadata = (transferId) => ({
    type: 'metadata', name: 'file.bin', size: 1, mime: 'application/octet-stream',
    transferId, encryption: null
  });
  await manager.handleIncomingTextMessage(JSON.stringify(metadata('failed-a')));
  await sendFinished(manager, 'failed-a', 1);
  assert.equal(controlMessages(channel, 'transfer-failed').length, 1);
  assert.equal(manager.receiverState.metadata, null);
  await manager.handleIncomingTextMessage(JSON.stringify(metadata('successful-b')));
  await manager.handleIncomingFileChunk(Uint8Array.from([1]).buffer);
  await sendFinished(manager, 'successful-b', 1);
  assert.equal(controlMessages(channel, 'transfer-ack')[0].transferId, 'successful-b');
});

test('unexpected second metadata cannot replace an active receiver transfer', async () => {
  const manager = createManager();
  const channel = new FakeDataChannel();
  manager.setDataChannel(channel);
  const first = {
    type: 'metadata', name: 'first.bin', size: 2, mime: 'application/octet-stream',
    transferId: 'metadata-a', encryption: null
  };
  const second = { ...first, name: 'second.bin', transferId: 'metadata-b' };
  channel.onmessage({ data: JSON.stringify(first) });
  await manager.incomingMessageChain;
  channel.onmessage({ data: JSON.stringify(second) });
  await manager.incomingMessageChain;
  assert.equal(manager.receiverState.metadata.transferId, 'metadata-a');
  assert.equal(manager.receiverState.metadata.name, 'first.bin');
  assert.equal(controlMessages(channel, 'receiver-ready').length, 1);
});

test('metadata arriving during an active disk write is rejected without mixing state', async () => {
  const writing = deferred();
  const { manager, channel, state } = prepareReceiver({
    size: 1,
    receivedSize: 0,
    receivedBuffers: [],
    writeMode: 'disk',
    writable: { write: () => writing.promise, close: async () => {}, abort: async () => {} }
  });
  const second = {
    type: 'metadata', name: 'second.bin', size: 1, mime: 'application/octet-stream',
    transferId: 'metadata-during-write', encryption: null
  };
  channel.onmessage({ data: Uint8Array.from([1]).buffer });
  channel.onmessage({ data: JSON.stringify(second) });
  writing.resolve();
  await manager.incomingMessageChain;
  assert.equal(manager.receiverState, state);
  assert.equal(manager.receiverState.metadata.transferId, 'receiver-transfer');
});

test('complete resume offset sends no chunks and still waits for one ACK', async () => {
  const file = createFile([1, 2, 3]);
  const { manager, channel, transferId, promise } = startSender({ file, resumeOffset: file.size });
  const finished = await waitForControl(channel, 'transfer-finished');
  assert.equal(finished.size, file.size);
  assert.equal(channel.sent.some((message) => typeof message !== 'string'), false);
  manager.handleTransferAck({ type: 'transfer-ack', transferId, size: file.size });
  await promise;
});

test('receiver with a complete resume offset throttles immediate duplicate terminal messages', async () => {
  const { manager, channel, state, transferId, size } = prepareReceiver();
  await manager.prepareIncomingFile({ ...state.metadata });
  manager.sendReceiverReady(transferId);
  assert.equal(controlMessages(channel, 'receiver-ready')[0].offset, size);
  await sendFinished(manager, transferId, size);
  await sendFinished(manager, transferId, size);
  assert.equal(controlMessages(channel, 'transfer-ack').length, 1);
});

test('resume offset above total size is safely bounded and another transferId is ignored', async () => {
  const manager = createManager();
  const transfer = {
    transferId: 'resume-current', totalBytes: 3, terminalState: null, terminalCallbackInvoked: false
  };
  manager.activeSendTransfer = transfer;
  const offsetPromise = new Promise((resolve) => manager.resumeWaiters.set(transfer.transferId, resolve));
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'receiver-ready', transferId: 'resume-other', offset: 3, size: 3
  }));
  assert.equal(manager.resumeWaiters.size, 1);
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'receiver-ready', transferId: transfer.transferId, offset: 99, size: 3
  }));
  assert.equal(await offsetPromise, 3);
});

test('stale ACK queued on a replaced channel cannot complete a resumed waiter', async () => {
  const manager = createManager({ deliveryAckTimeout: 1000 });
  const oldChannel = new FakeDataChannel();
  manager.setDataChannel(oldChannel);
  const blocked = deferred();
  manager.incomingMessageChain = blocked.promise;
  oldChannel.onmessage({ data: JSON.stringify({
    type: 'transfer-ack', transferId: 'resumed-transfer', size: 1
  }) });
  manager.setDataChannel(new FakeDataChannel());
  manager.activeSendTransfer = {
    transferId: 'resumed-transfer', terminalState: null, terminalCallbackInvoked: false
  };
  const waiter = manager.createDeliveryWaiter('resumed-transfer', 1);
  blocked.resolve();
  await manager.incomingMessageChain;
  assert.equal(manager.deliveryWaiters.size, 1);
  manager.handleTransferAck({ type: 'transfer-ack', transferId: 'resumed-transfer', size: 1 });
  await waiter;
});

test('delivery message validation enforces IDs, sizes, fields, and failure reasons', () => {
  const manager = createManager();
  assert.equal(manager.isValidTransferId('x'.repeat(128)), true);
  assert.equal(manager.isValidTransferId('x'.repeat(129)), false);
  assert.equal(manager.isValidTransferId(''), false);
  assert.equal(manager.isValidTransferId('   '), false);

  for (const size of [NaN, Infinity, '1', -1, 1.5]) {
    assert.equal(manager.isValidTransferSize(size), false);
    assert.equal(manager.isValidTransferTerminalMessage({
      type: 'transfer-ack', transferId: 'valid-id', size
    }, true), false);
  }
  assert.equal(manager.isValidTransferTerminalMessage({
    type: 'transfer-finished', transferId: 'valid-id', size: 0
  }, true), true);
  assert.equal(manager.isValidTransferTerminalMessage({
    type: 'transfer-finished', transferId: 'valid-id', size: 0, extra: true
  }, true), false);
  assert.equal(manager.isValidTransferTerminalMessage({
    type: 'transfer-failed', transferId: 'valid-id', reason: 'CANCELLED'
  }, false), true);
  assert.equal(manager.isValidTransferTerminalMessage({
    type: 'transfer-failed', transferId: 'valid-id', reason: 'PRIVATE_REASON'
  }, false), false);
  assert.equal(manager.hasExactMessageFields({
    type: 'transfer-cancelled', transferId: 'valid-id'
  }, ['type', 'transferId']), true);
  assert.equal(manager.hasExactMessageFields({
    type: 'transfer-cancelled', transferId: 'valid-id', name: 'private.bin'
  }, ['type', 'transferId']), false);
  assert.equal(manager.handleTransferAck(null), false);
  assert.equal(manager.handleTransferFailed([]), false);
});

test('delayed decrypt from an obsolete channel is ignored after replacement', async () => {
  const decrypted = deferred();
  const { manager, channel: oldChannel, state } = prepareReceiver({
    size: 1, receivedSize: 0, receivedBuffers: []
  });
  state.metadata.encryption = 'aes-gcm-256';
  manager.decryptChunk = () => decrypted.promise;
  oldChannel.onmessage({ data: Uint8Array.from([1]).buffer });
  manager.setDataChannel(new FakeDataChannel());
  decrypted.resolve(Uint8Array.from([1]).buffer);
  await manager.incomingMessageChain;
  assert.equal(state.receivedSize, 0);
  assert.equal(state.receivedBuffers.length, 0);
});

test('queued transfer-finished from an obsolete channel cannot ACK on replacement channel', async () => {
  const { manager, channel: oldChannel, transferId, size } = prepareReceiver();
  const blocked = deferred();
  manager.incomingMessageChain = blocked.promise;
  oldChannel.onmessage({ data: JSON.stringify({ type: 'transfer-finished', transferId, size }) });
  const replacement = new FakeDataChannel();
  manager.setDataChannel(replacement);
  blocked.resolve();
  await manager.incomingMessageChain;
  assert.equal(controlMessages(replacement, 'transfer-ack').length, 0);
});

test('close prevents queued work from completing a receiver transfer', async () => {
  const { manager, channel, transferId, size } = prepareReceiver();
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  const blocked = deferred();
  manager.incomingMessageChain = blocked.promise;
  channel.onmessage({ data: JSON.stringify({ type: 'transfer-finished', transferId, size }) });
  manager.close();
  blocked.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions, 0);
  assert.equal(manager.receiverState.metadata, null);
});

test('application maps delivery failures without completion or a stuck progress panel', () => {
  const app = read('public/js/app.js');
  assert.match(app, /await webrtcManager\.sendFile\([\s\S]*nextItem\.status = 'done'/);
  assert.match(app, /DELIVERY_ACK_TIMEOUT|transfer_fail/);
  assert.match(app, /connection \(is not ready\|closed\)[\s\S]*nextItem\.status = 'pending'/);
  assert.match(app, /webrtcManager\.onTransferError[\s\S]*recordNetworkHealth\('failed'\)[\s\S]*progressCard\.classList\.add\('hidden'\)/);
  assert.match(app, /webrtcManager\.onFileTransferCancelled[\s\S]*recordNetworkHealth\('cancelled'\)/);
});
