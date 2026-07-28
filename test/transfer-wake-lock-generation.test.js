'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSentinel(options = {}) {
  const listeners = new Map();
  const releaseGate = options.releaseGate || null;
  return {
    releaseCalls: 0,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async release() {
      this.releaseCalls += 1;
      if (releaseGate) {
        await releaseGate.promise;
      }
      listeners.get('release')?.();
    },
    emitRelease() {
      listeners.get('release')?.();
    }
  };
}

function loadWakeLockHarness(navigatorValue) {
  const startAnchor = 'function beginTransferWakeLock';
  const endAnchor = '\n  function setNativeTransferKeepAlive';
  const start = appSource.indexOf(startAnchor);
  const end = appSource.indexOf(endAnchor, start);
  assert.notEqual(start, -1, `Missing source anchor: ${startAnchor}`);
  assert.notEqual(end, -1, `Missing source anchor: ${endAnchor}`);
  assert.ok(end > start, 'Wake Lock source anchors are out of order');

  const context = {
    navigator: navigatorValue,
    console: { info() {} }
  };
  vm.createContext(context);
  return vm.runInContext(
    `(function () {
      let transferIsActive = false;
      let wakeLock = null;
      let wakeLockRequest = null;
      let wakeLockGeneration = 0;
      ${appSource.slice(start, end)}
      return {
        begin() {
          transferIsActive = true;
          return beginTransferWakeLock();
        },
        cancel() {
          transferIsActive = false;
          return releaseTransferWakeLock();
        },
        complete() {
          transferIsActive = false;
          return releaseTransferWakeLock();
        },
        acquire() {
          return acquireTransferWakeLock();
        },
        state() {
          return { transferIsActive, wakeLock, wakeLockRequest, wakeLockGeneration };
        }
      };
    })()`,
    context
  );
}

function createWakeLockQueue() {
  const requests = [];
  return {
    navigator: {
      wakeLock: {
        request(type) {
          assert.equal(type, 'screen');
          const gate = deferred();
          requests.push(gate);
          return gate.promise;
        }
      }
    },
    requests
  };
}

async function settleAcquisition(harness) {
  const request = harness.state().wakeLockRequest;
  if (request) {
    await request.promise;
  }
}

test('completion before Wake Lock acquisition resolves releases the late sentinel', async () => {
  const queue = createWakeLockQueue();
  const harness = loadWakeLockHarness(queue.navigator);
  harness.begin();
  await harness.complete();

  const sentinel = createSentinel();
  queue.requests[0].resolve(sentinel);
  await settleAcquisition(harness);

  assert.equal(sentinel.releaseCalls, 1);
  assert.equal(harness.state().wakeLock, null);
});

test('cancellation before Wake Lock acquisition resolves releases the late sentinel', async () => {
  const queue = createWakeLockQueue();
  const harness = loadWakeLockHarness(queue.navigator);
  harness.begin();
  await harness.cancel();

  const sentinel = createSentinel();
  queue.requests[0].resolve(sentinel);
  await settleAcquisition(harness);

  assert.equal(sentinel.releaseCalls, 1);
  assert.equal(harness.state().wakeLock, null);
});

test('a new transfer supersedes an unresolved Wake Lock request', async () => {
  const queue = createWakeLockQueue();
  const harness = loadWakeLockHarness(queue.navigator);
  harness.begin();
  await harness.complete();
  harness.begin();

  const currentSentinel = createSentinel();
  queue.requests[1].resolve(currentSentinel);
  await settleAcquisition(harness);

  const oldSentinel = createSentinel();
  queue.requests[0].resolve(oldSentinel);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(oldSentinel.releaseCalls, 1);
  assert.equal(currentSentinel.releaseCalls, 0);
  assert.equal(harness.state().wakeLock.sentinel, currentSentinel);
});

test('late release of an old Wake Lock cannot clear a newer lock', async () => {
  const queue = createWakeLockQueue();
  const harness = loadWakeLockHarness(queue.navigator);
  const oldReleaseGate = deferred();
  const oldSentinel = createSentinel({ releaseGate: oldReleaseGate });

  harness.begin();
  queue.requests[0].resolve(oldSentinel);
  await settleAcquisition(harness);

  const oldRelease = harness.complete();
  harness.begin();
  const currentSentinel = createSentinel();
  queue.requests[1].resolve(currentSentinel);
  await settleAcquisition(harness);

  oldReleaseGate.resolve();
  await oldRelease;
  oldSentinel.emitRelease();

  assert.equal(harness.state().wakeLock.sentinel, currentSentinel);
  assert.equal(currentSentinel.releaseCalls, 0);
});

test('normal Wake Lock acquisition and release retain only the active transfer lock', async () => {
  const queue = createWakeLockQueue();
  const harness = loadWakeLockHarness(queue.navigator);
  const sentinel = createSentinel();

  harness.begin();
  queue.requests[0].resolve(sentinel);
  await settleAcquisition(harness);
  assert.equal(harness.state().wakeLock.sentinel, sentinel);

  await harness.complete();
  assert.equal(sentinel.releaseCalls, 1);
  assert.equal(harness.state().wakeLock, null);
  await harness.complete();
  assert.equal(sentinel.releaseCalls, 1);
});

test('a browser without Wake Lock support leaves no pending state', async () => {
  const harness = loadWakeLockHarness({});

  harness.begin();
  assert.equal(await harness.acquire(), false);
  assert.equal(harness.state().wakeLock, null);
  assert.equal(harness.state().wakeLockRequest, null);
  await harness.complete();
});

test('Wake Lock rejection and browser release events clean only their own generation', async () => {
  const queue = createWakeLockQueue();
  const harness = loadWakeLockHarness(queue.navigator);

  harness.begin();
  queue.requests[0].reject(new Error('not allowed'));
  await settleAcquisition(harness);
  assert.equal(harness.state().wakeLock, null);
  assert.equal(harness.state().wakeLockRequest, null);

  await harness.complete();
  harness.begin();
  const sentinel = createSentinel();
  queue.requests[1].resolve(sentinel);
  await settleAcquisition(harness);
  sentinel.emitRelease();
  assert.equal(harness.state().wakeLock, null);
});
