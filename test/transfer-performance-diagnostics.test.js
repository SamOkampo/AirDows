const test = require('node:test');
const assert = require('node:assert/strict');

const TransferPerformanceDiagnostics = require('../public/js/transfer-performance-diagnostics.js');
const WebRTCManager = require('../public/js/webrtc-manager.js');

function createClock(initial = 0) {
  let value = initial;
  return {
    now: () => value,
    set: (next) => {
      value = next;
    },
    advance: (amount) => {
      value += amount;
    }
  };
}

function startMeasuredTransfer(diagnostics, clock, overrides = {}) {
  return diagnostics.startTransfer({
    transferId: 'internal-transfer-id',
    generation: 7,
    direction: 'send',
    totalBytes: 1024 * 1024,
    selectedAt: clock.now() - 25,
    route: 'host',
    performanceProfile: 'Directa veloz',
    chunkSize: 256 * 1024,
    bufferThreshold: 8 * 1024 * 1024,
    receiverMode: 'send',
    ...overrides
  });
}

test('calculates connection and transfer performance durations deterministically', () => {
  const clock = createClock(0);
  const diagnostics = new TransferPerformanceDiagnostics({
    now: clock.now,
    epochNow: () => 1_000_000 + clock.now()
  });

  diagnostics.beginPairing({ generation: 3 });
  clock.set(100);
  diagnostics.markPaired(3);
  clock.set(250);
  diagnostics.markDataChannelState('open', 3);

  clock.set(300);
  startMeasuredTransfer(diagnostics, clock);
  clock.set(320);
  diagnostics.markSenderEnqueueStart('internal-transfer-id', 7);
  clock.set(350);
  diagnostics.markFirstByte('internal-transfer-id', 7);
  diagnostics.markReceiverByteArrival(
    'internal-transfer-id',
    512 * 1024,
    { monotonicMs: 360, epochMs: 1_000_360 },
    7
  );
  diagnostics.markBytes('internal-transfer-id', 1024 * 1024, 7);
  diagnostics.addEncryptionTime('internal-transfer-id', 25, 7);
  diagnostics.addBackpressureWait('internal-transfer-id', 40, 2, 7);
  clock.set(700);
  diagnostics.markReceiverByteArrival(
    'internal-transfer-id',
    1024 * 1024,
    { monotonicMs: 690, epochMs: 1_000_690 },
    7
  );
  diagnostics.markSenderEnqueueEnd('internal-transfer-id', 7);
  diagnostics.markDataFinished('internal-transfer-id', 7);
  diagnostics.markSenderBufferedAmountBeforeTerminal('internal-transfer-id', 4096, 7);
  diagnostics.markSenderBufferedAmountAfterTerminal('internal-transfer-id', 4200, 7);
  diagnostics.markTerminalSent('internal-transfer-id', 7);
  clock.set(715);
  diagnostics.markReceiverTerminalArrival(
    'internal-transfer-id',
    { monotonicMs: 715, epochMs: 1_000_715 },
    7
  );
  clock.set(720);
  diagnostics.markReceiverFinalizationStart('internal-transfer-id', 7);
  clock.set(760);
  diagnostics.markReceiverFinalizationEnd('internal-transfer-id', 7);
  clock.set(765);
  diagnostics.markAckSent('internal-transfer-id', 7);
  clock.set(800);
  diagnostics.markAckReceived('internal-transfer-id', 7);
  clock.set(900);
  assert.equal(diagnostics.completeTransfer('internal-transfer-id', 7), true);

  assert.deepEqual(diagnostics.getConnectionSnapshot(), {
    generation: 3,
    sequence: 1,
    dataChannelState: 'open',
    pairingTimeMs: 100,
    dataChannelOpenTimeMs: 150
  });

  const result = diagnostics.getLatestTransfer();
  assert.equal(result.status, 'completed');
  assert.equal(result.pairingTimeMs, 100);
  assert.equal(result.dataChannelOpenTimeMs, 150);
  assert.equal(result.selectionToStartMs, 25);
  assert.equal(result.timeToFirstByteMs, 50);
  assert.equal(result.senderEnqueueDurationMs, 380);
  assert.equal(result.senderEnqueueFinishedAtEpochMs, 1_000_700);
  assert.equal(result.senderBufferedAmountBeforeTerminalBytes, 4096);
  assert.equal(result.senderBufferedAmountAfterTerminalBytes, 4200);
  assert.equal(result.receiverFirstByteArrivedAtEpochMs, 1_000_360);
  assert.equal(result.receiverLastByteArrivedAtEpochMs, 1_000_690);
  assert.equal(result.receiverTerminalArrivedAtEpochMs, 1_000_715);
  assert.equal(result.receiverFinalizationDurationMs, 40);
  assert.equal(result.receiverTerminalToAckSendMs, 50);
  assert.equal(result.terminalSentAtEpochMs, 1_000_700);
  assert.equal(result.ackSentAtEpochMs, 1_000_765);
  assert.equal(result.ackReceivedAtEpochMs, 1_000_800);
  assert.equal(result.senderTerminalQueuedToAckMs, 100);
  assert.equal(result.totalDurationMs, 625);
  assert.equal(result.bytesTransferred, 1024 * 1024);
  assert.equal(result.totalBytes, 1024 * 1024);
  assert.equal(result.averageThroughputBytesPerSecond, (1024 * 1024) / 0.625);
  assert.equal(result.averageThroughputMBps, 1.6);
  assert.equal(result.route, 'host');
  assert.equal(result.performanceProfile, 'Directa veloz');
  assert.equal(result.chunkSize, 256 * 1024);
  assert.equal(result.bufferThreshold, 8 * 1024 * 1024);
  assert.equal(result.backpressureWaitMs, 40);
  assert.equal(result.encryptionTimeMs, 25);
  assert.equal(result.backpressurePauses, 2);
  assert.equal(result.receiverMode, 'send');
  assert.equal(result.completionCount, 1);
});

test('terminal completion and timing marks are idempotent', () => {
  const clock = createClock(10);
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });
  startMeasuredTransfer(diagnostics, clock);

  assert.equal(diagnostics.markFirstByte('internal-transfer-id', undefined, 7), true);
  clock.advance(5);
  assert.equal(diagnostics.markFirstByte('internal-transfer-id', undefined, 7), true);
  diagnostics.markTerminalSent('internal-transfer-id', 7);
  clock.advance(5);
  diagnostics.markTerminalSent('internal-transfer-id', 7);
  diagnostics.markAckReceived('internal-transfer-id', 7);
  clock.advance(5);
  diagnostics.markAckReceived('internal-transfer-id', 7);

  assert.equal(diagnostics.completeTransfer('internal-transfer-id', 7), true);
  assert.equal(diagnostics.completeTransfer('internal-transfer-id', 7), false);
  assert.equal(diagnostics.failTransfer('internal-transfer-id', 7), false);
  assert.equal(diagnostics.cancelTransfer('internal-transfer-id', 7), false);
  assert.equal(diagnostics.getCompletedTransfers().length, 1);
  assert.equal(diagnostics.getLatestTransfer().completionCount, 1);
  assert.equal(diagnostics.getLatestTransfer().timeToFirstByteMs, 0);
  assert.equal(diagnostics.getLatestTransfer().senderTerminalQueuedToAckMs, 5);
});

test('late updates from replaced transfer ids and generations are ignored', () => {
  const clock = createClock(100);
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });

  startMeasuredTransfer(diagnostics, clock, {
    transferId: 'transfer-a',
    generation: 1
  });
  clock.advance(10);
  startMeasuredTransfer(diagnostics, clock, {
    transferId: 'transfer-b',
    generation: 2,
    totalBytes: 500
  });

  assert.equal(diagnostics.markBytes('transfer-a', 400, 1), false);
  assert.equal(diagnostics.markBytes('transfer-b', 400, 1), false);
  assert.equal(diagnostics.markFirstByte('transfer-a', undefined, 1), false);
  assert.equal(diagnostics.completeTransfer('transfer-a', 1), false);

  assert.equal(diagnostics.markBytes('transfer-b', 400, 2), true);
  assert.equal(diagnostics.markFirstByte('transfer-b', undefined, 2), true);
  assert.equal(diagnostics.getActiveTransfer().bytesTransferred, 400);
  assert.equal(diagnostics.getActiveTransfer().sequence, 2);
});

test('mark methods may capture the current generation but reject a replaced session', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });
  diagnostics.beginPairing({ generation: 10 });
  startMeasuredTransfer(diagnostics, clock, {
    transferId: 'current-transfer',
    generation: 5,
    sessionGeneration: 10
  });

  assert.equal(diagnostics.markFirstByte('current-transfer'), true);
  assert.equal(diagnostics.markBytes('current-transfer', 50), true);
  assert.equal(diagnostics.addEncryptionTime('current-transfer', 2), true);

  diagnostics.beginPairing({ generation: 11 });
  assert.equal(diagnostics.markBytes('current-transfer', 100), false);
  assert.equal(diagnostics.completeTransfer('current-transfer'), false);
});

test('late connection states from a replaced pairing generation are ignored', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });

  diagnostics.beginPairing({ generation: 1 });
  clock.advance(10);
  diagnostics.beginPairing({ generation: 2 });

  assert.equal(diagnostics.markPaired(1), false);
  assert.equal(diagnostics.markDataChannelState('open', 1), false);
  assert.equal(diagnostics.markPaired(2), true);
  clock.advance(20);
  assert.equal(diagnostics.markDataChannelState('open', 2), true);
  assert.equal(diagnostics.getConnectionSnapshot().dataChannelOpenTimeMs, 20);
});

test('returns independent copies instead of exposing mutable internal state', () => {
  const clock = createClock(50);
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });
  startMeasuredTransfer(diagnostics, clock);

  const active = diagnostics.getActiveTransfer();
  active.bytesTransferred = 999;
  active.route = 'relay';
  assert.equal(diagnostics.getActiveTransfer().bytesTransferred, 0);
  assert.equal(diagnostics.getActiveTransfer().route, 'host');

  diagnostics.completeTransfer('internal-transfer-id', 7);
  const completed = diagnostics.getCompletedTransfers();
  completed[0].status = 'failed';
  completed.push({ status: 'injected' });
  assert.equal(diagnostics.getCompletedTransfers().length, 1);
  assert.equal(diagnostics.getLatestTransfer().status, 'completed');
});

test('updateTransfer applies only its strict non-sensitive allowlist', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });
  startMeasuredTransfer(diagnostics, clock);

  assert.equal(diagnostics.updateTransfer('internal-transfer-id', {
    route: 'relay',
    performanceProfile: 'Relay optimizado',
    chunkSize: 64 * 1024,
    bufferThreshold: 4 * 1024 * 1024,
    receiverMode: 'disk',
    fileName: 'private.jpg',
    pairingCode: '1234',
    content: 'private'
  }, 7), true);

  const snapshot = diagnostics.getActiveTransfer();
  assert.equal(snapshot.route, 'relay');
  assert.equal(snapshot.performanceProfile, 'Relay optimizado');
  assert.equal(snapshot.chunkSize, 64 * 1024);
  assert.equal(snapshot.bufferThreshold, 4 * 1024 * 1024);
  assert.equal(snapshot.receiverMode, 'disk');
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  assert.equal(JSON.stringify(snapshot).includes('1234'), false);
});

test('createPublicApi exposes only frozen copy getters and clear', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });
  startMeasuredTransfer(diagnostics, clock);

  const publicApi = diagnostics.createPublicApi();
  assert.equal(Object.isFrozen(publicApi), true);
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'clear',
    'getActiveTransfer',
    'getCompletedTransfers',
    'getConnectionSnapshot',
    'getLatestTransfer'
  ]);
  assert.equal('startTransfer' in publicApi, false);
  assert.equal('updateTransfer' in publicApi, false);

  const exposed = publicApi.getActiveTransfer();
  exposed.bytesTransferred = 999;
  assert.equal(publicApi.getActiveTransfer().bytesTransferred, 0);

  publicApi.clear();
  assert.equal(publicApi.getActiveTransfer(), null);
});

test('bounds retained terminal snapshots', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({
    now: clock.now,
    maxCompleted: 2
  });

  for (let index = 1; index <= 3; index += 1) {
    diagnostics.startTransfer({
      transferId: `transfer-${index}`,
      generation: index,
      totalBytes: index
    });
    diagnostics.markBytes(`transfer-${index}`, index, index);
    diagnostics.completeTransfer(`transfer-${index}`, index);
    clock.advance(1);
  }

  const retained = diagnostics.getCompletedTransfers();
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.map((snapshot) => snapshot.sequence), [2, 3]);
});

test('failed and cancelled transfers settle once without reporting completion', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });

  startMeasuredTransfer(diagnostics, clock, {
    transferId: 'failed-transfer',
    generation: 1
  });
  assert.equal(diagnostics.failTransfer('failed-transfer', 1), true);
  assert.equal(diagnostics.failTransfer('failed-transfer', 1), false);
  assert.equal(diagnostics.getLatestTransfer().status, 'failed');
  assert.equal(diagnostics.getLatestTransfer().completionCount, 0);

  startMeasuredTransfer(diagnostics, clock, {
    transferId: 'cancelled-transfer',
    generation: 2
  });
  assert.equal(diagnostics.cancelTransfer('cancelled-transfer', 2), true);
  assert.equal(diagnostics.completeTransfer('cancelled-transfer', 2), false);
  assert.equal(diagnostics.getLatestTransfer().status, 'cancelled');
  assert.equal(diagnostics.getLatestTransfer().completionCount, 0);
});

test('public snapshots exclude transfer ids and sensitive fields and values', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });
  const secrets = {
    transferId: 'secret-transfer-id',
    fileName: 'private-photo.jpg',
    pairingCode: '1234',
    ipAddress: '192.0.2.10',
    recoveryToken: 'secret-recovery-token',
    encryptionKey: 'secret-encryption-key',
    content: 'private-file-content',
    localPath: 'C:\\private\\photo.jpg'
  };

  diagnostics.startTransfer({
    ...secrets,
    generation: 4,
    totalBytes: 10,
    route: 'host',
    performanceProfile: 'Directa veloz'
  });
  diagnostics.markBytes(secrets.transferId, 10, 4);
  diagnostics.completeTransfer(secrets.transferId, 4);

  const serialized = JSON.stringify({
    connection: diagnostics.getConnectionSnapshot(),
    active: diagnostics.getActiveTransfer(),
    completed: diagnostics.getCompletedTransfers(),
    latest: diagnostics.getLatestTransfer()
  });

  for (const [field, value] of Object.entries(secrets)) {
    assert.equal(serialized.includes(field), false, `must not expose ${field}`);
    assert.equal(serialized.includes(value), false, `must not expose ${field} value`);
  }
});

test('invalid public classifications are reduced to non-sensitive defaults', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });

  diagnostics.startTransfer({
    transferId: 'transfer',
    generation: 1,
    direction: 'private-direction',
    route: '192.0.2.10',
    performanceProfile: 'private-photo.jpg',
    receiverMode: 'C:\\private',
    chunkSize: -1,
    bufferThreshold: Number.POSITIVE_INFINITY
  });

  const snapshot = diagnostics.getActiveTransfer();
  assert.equal(snapshot.direction, 'send');
  assert.equal(snapshot.route, 'unknown');
  assert.equal(snapshot.performanceProfile, 'unknown');
  assert.equal(snapshot.receiverMode, 'unknown');
  assert.equal(snapshot.chunkSize, 0);
  assert.equal(snapshot.bufferThreshold, 0);
});

test('clear invalidates active updates and removes all public snapshots', () => {
  const clock = createClock();
  const diagnostics = new TransferPerformanceDiagnostics({ now: clock.now });
  diagnostics.beginPairing({ generation: 1 });
  startMeasuredTransfer(diagnostics, clock);

  diagnostics.clear();

  assert.equal(diagnostics.markPaired(1), false);
  assert.equal(diagnostics.markBytes('internal-transfer-id', 1, 7), false);
  assert.equal(diagnostics.getConnectionSnapshot(), null);
  assert.equal(diagnostics.getActiveTransfer(), null);
  assert.deepEqual(diagnostics.getCompletedTransfers(), []);
  assert.equal(diagnostics.getLatestTransfer(), null);
});

test('diagnostics require one exact query opt-in and ignore fragments', () => {
  assert.equal(
    TransferPerformanceDiagnostics.isRequested('https://example.test/app?diagnostics=1'),
    true
  );
  assert.equal(
    TransferPerformanceDiagnostics.isRequested('https://example.test/app?shared=1&diagnostics=1'),
    true
  );

  for (const url of [
    'https://example.test/app',
    'https://example.test/app?diagnostics=',
    'https://example.test/app?diagnostics=true',
    'https://example.test/app?diagnostics=0',
    'https://example.test/app?diagnostics=1&diagnostics=1',
    'https://example.test/app#diagnostics=1',
    'not a valid absolute URL?diagnostics=0'
  ]) {
    assert.equal(TransferPerformanceDiagnostics.isRequested(url), false, url);
  }
});

test('WebRTC diagnostics stay disabled by default and publish only after opt-in', () => {
  const originalWindow = global.window;
  const originalDiagnosticsClass = global.AirDowsTransferPerformanceDiagnostics;

  try {
    global.AirDowsTransferPerformanceDiagnostics = TransferPerformanceDiagnostics;
    global.window = {};
    const defaultManager = new WebRTCManager({});
    assert.equal(defaultManager.performanceDiagnostics, null);
    assert.equal(Object.hasOwn(global.window, 'airDowsDiagnostics'), false);

    const enabledManager = new WebRTCManager({}, {
      performanceDiagnosticsEnabled: true
    });
    assert.ok(enabledManager.performanceDiagnostics instanceof TransferPerformanceDiagnostics);
    assert.equal(Object.isFrozen(global.window.airDowsDiagnostics), true);
    assert.equal(
      typeof global.window.airDowsDiagnostics.getCompletedTransfers,
      'function'
    );
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDiagnosticsClass === undefined) {
      delete global.AirDowsTransferPerformanceDiagnostics;
    } else {
      global.AirDowsTransferPerformanceDiagnostics = originalDiagnosticsClass;
    }
  }
});

test('arrival and terminal milestones preserve the first observation', () => {
  const clock = createClock(10);
  const diagnostics = new TransferPerformanceDiagnostics({
    now: clock.now,
    epochNow: () => 5000 + clock.now()
  });
  startMeasuredTransfer(diagnostics, clock, { totalBytes: 100 });

  assert.equal(diagnostics.markReceiverByteArrival(
    'internal-transfer-id',
    20,
    { monotonicMs: 11, epochMs: 5011 },
    7
  ), true);
  assert.equal(diagnostics.markReceiverByteArrival(
    'internal-transfer-id',
    100,
    { monotonicMs: 12, epochMs: 5012 },
    7
  ), true);
  assert.equal(diagnostics.markReceiverByteArrival(
    'internal-transfer-id',
    100,
    { monotonicMs: 99, epochMs: 5099 },
    7
  ), true);
  assert.equal(diagnostics.markReceiverTerminalArrival(
    'internal-transfer-id',
    { monotonicMs: 13, epochMs: 5013 },
    7
  ), true);
  assert.equal(diagnostics.markReceiverTerminalArrival(
    'internal-transfer-id',
    { monotonicMs: 98, epochMs: 5098 },
    7
  ), true);
  diagnostics.markAckSent('internal-transfer-id', 7, {
    monotonicMs: 14,
    epochMs: 5014
  });
  diagnostics.markAckSent('internal-transfer-id', 7, {
    monotonicMs: 97,
    epochMs: 5097
  });

  const snapshot = diagnostics.getActiveTransfer();
  assert.equal(snapshot.receiverFirstByteArrivedAtEpochMs, 5011);
  assert.equal(snapshot.receiverLastByteArrivedAtEpochMs, 5012);
  assert.equal(snapshot.receiverTerminalArrivedAtEpochMs, 5013);
  assert.equal(snapshot.ackSentAtEpochMs, 5014);
  assert.equal(snapshot.receiverTerminalToAckSendMs, 1);
});

test('diagnostic clocks and invalid buffer samples cannot throw into callers', () => {
  const diagnostics = new TransferPerformanceDiagnostics({
    now: () => {
      throw new Error('clock unavailable');
    },
    epochNow: () => {
      throw new Error('epoch unavailable');
    }
  });

  assert.doesNotThrow(() => {
    diagnostics.beginPairing({ generation: 1 });
    diagnostics.startTransfer({
      transferId: 'transfer',
      generation: 1,
      sessionGeneration: 1,
      totalBytes: 1
    });
    diagnostics.markSenderEnqueueStart('transfer', 1);
    diagnostics.markSenderEnqueueEnd('transfer', 1);
    diagnostics.markReceiverByteArrival('transfer', 1, undefined, 1);
    diagnostics.markReceiverTerminalArrival('transfer', undefined, 1);
    diagnostics.markTerminalSent('transfer', 1);
    diagnostics.markAckSent('transfer', 1);
    diagnostics.markAckReceived('transfer', 1);
  });

  assert.equal(
    diagnostics.markSenderBufferedAmountBeforeTerminal('transfer', Number.POSITIVE_INFINITY, 1),
    false
  );
  assert.equal(
    diagnostics.markSenderBufferedAmountAfterTerminal('transfer', -1, 1),
    false
  );
  const snapshot = diagnostics.getActiveTransfer();
  assert.equal(snapshot.senderBufferedAmountBeforeTerminalBytes, null);
  assert.equal(snapshot.senderBufferedAmountAfterTerminalBytes, null);
  assert.equal(snapshot.senderEnqueueDurationMs, 0);
});

test('throwing diagnostic hooks cannot change a DataChannel send', async () => {
  const manager = new WebRTCManager({});
  let sends = 0;
  manager.dataChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send() {
      sends += 1;
    }
  };

  await assert.doesNotReject(() => manager.sendWithBackpressure(
    new Uint8Array([1]),
    1024,
    null,
    {
      beforeSend() {
        throw new Error('diagnostic before-send failure');
      },
      afterSend() {
        throw new Error('diagnostic after-send failure');
      }
    }
  ));
  assert.equal(sends, 1);

  manager.performanceDiagnostics = {
    markAckReceived() {
      throw new Error('diagnostic recorder failure');
    }
  };
  assert.doesNotThrow(() => manager.recordPerformance('markAckReceived', 'opaque-id'));
});

test('network diagnostics do not inspect WebRTC stats without a consumer', async () => {
  const manager = new WebRTCManager({});
  let statsInspections = 0;
  let metricLogs = 0;
  const originalInfo = console.info;
  manager.peerConnection = {};
  manager.getActiveCandidatePairDetails = async () => {
    statsInspections += 1;
    return { connectionType: 'host' };
  };
  console.info = (...args) => {
    if (args[0] === '[AirDows] Transfer metrics') metricLogs += 1;
  };

  try {
    assert.equal(manager.startNetworkDiagnostics({
      transferId: 'transfer',
      direction: 'send',
      totalBytes: 10,
      getBytesTransferred: () => 1
    }), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statsInspections, 0);
    assert.equal(metricLogs, 0);
    assert.equal(manager.diagnosticsInterval, null);
    assert.equal(manager.diagnosticsTransfer, null);
  } finally {
    console.info = originalInfo;
    manager.stopNetworkDiagnostics();
  }
});

test('UI network diagnostics callback keeps periodic measurement active', async () => {
  const manager = new WebRTCManager({});
  const received = [];
  let statsInspections = 0;
  manager.peerConnection = {};
  manager.onNetworkDiagnostics = (metrics) => received.push(metrics);
  manager.getActiveCandidatePairDetails = async () => {
    statsInspections += 1;
    return { connectionType: 'host' };
  };

  try {
    assert.equal(manager.startNetworkDiagnostics({
      transferId: 'transfer',
      direction: 'send',
      totalBytes: 10,
      getBytesTransferred: () => 5
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statsInspections, 1);
    assert.equal(received.length, 1);
    assert.equal(received[0].connectionType, 'host');
    assert.notEqual(manager.diagnosticsInterval, null);
  } finally {
    manager.stopNetworkDiagnostics();
  }
});

test('opt-in performance diagnostics measure route without a UI callback', async () => {
  const manager = new WebRTCManager({}, {
    performanceDiagnosticsEnabled: true
  });
  let statsInspections = 0;
  manager.peerConnection = {};
  manager.getActiveCandidatePairDetails = async () => {
    statsInspections += 1;
    return { connectionType: 'relay' };
  };
  manager.performanceDiagnostics.startTransfer({
    transferId: 'transfer',
    generation: 1,
    direction: 'send',
    totalBytes: 10
  });

  try {
    assert.equal(manager.startNetworkDiagnostics({
      transferId: 'transfer',
      direction: 'send',
      totalBytes: 10,
      getBytesTransferred: () => 5
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statsInspections, 1);
    assert.equal(manager.onNetworkDiagnostics, null);
    assert.equal(manager.performanceDiagnostics.getActiveTransfer().route, 'relay');
  } finally {
    manager.stopNetworkDiagnostics();
  }
});

test('a failing performance diagnostic hook cannot reject metric collection', async () => {
  const manager = new WebRTCManager({});
  let statsInspections = 0;
  const originalWarn = console.warn;
  manager.performanceDiagnostics = {
    updateTransfer() {
      throw new Error('synthetic diagnostics failure');
    }
  };
  manager.peerConnection = {};
  manager.diagnosticsTransfer = {
    transferId: 'transfer',
    direction: 'send',
    totalBytes: 10,
    getBytesTransferred: () => 5
  };
  manager.lastDiagnosticsTimestamp = manager.performanceNow();
  manager.getActiveCandidatePairDetails = async () => {
    statsInspections += 1;
    return { connectionType: 'host' };
  };
  console.warn = () => {};

  try {
    await assert.doesNotReject(() => manager.emitNetworkDiagnostics());
    assert.equal(statsInspections, 1);
    assert.equal(manager.lastDiagnosticsMetrics.connectionType, 'host');
  } finally {
    console.warn = originalWarn;
    manager.stopNetworkDiagnostics();
  }
});
