'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SocketManager } = require('../public/js/socket-manager');
const WebRTCManager = require('../public/js/webrtc-manager');

const ROOT = path.join(__dirname, '..');

function loadAppHotfixHelpers() {
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const helperStartAnchor = 'function createPairingPrivacyFacade';
  const helperEndAnchor = 'const pairingPrivacy =';
  const helperStart = appSource.indexOf(helperStartAnchor);
  const helperEnd = appSource.indexOf(helperEndAnchor);
  assert.notEqual(helperStart, -1, `Missing app.js helper start anchor: ${helperStartAnchor}`);
  assert.notEqual(helperEnd, -1, `Missing app.js helper end anchor: ${helperEndAnchor}`);
  assert.ok(helperStart < helperEnd, 'app.js helper anchors are reordered');
  const helperSource = appSource.slice(helperStart, helperEnd);
  const context = {};
  vm.runInNewContext(
    `${helperSource}\n;globalThis.hotfixHelpers = { applyRecoveryState, clearAutomaticReconnect, isAutomaticReconnectAllowed, markManualActionDelivered, runAutomaticReconnect, submitManualJoin };`,
    context
  );
  return context.hotfixHelpers;
}

test('late expired recovery state cannot overwrite a pending manual reconnect guard', () => {
  const { applyRecoveryState, isAutomaticReconnectAllowed } = loadAppHotfixHelpers();
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const state = applyRecoveryState('manual-reconnect', 'expired');

  assert.equal(state, 'manual-reconnect');
  assert.equal(isAutomaticReconnectAllowed(state), false);
  assert.match(
    appSource,
    /onRecoveryStateChange = \(state\) => \{\s*const nextState = applyRecoveryState\(sessionRecoveryState, state\)/
  );
});

test('late expired recovery state cannot schedule a new reconnect timer', () => {
  const { applyRecoveryState, isAutomaticReconnectAllowed } = loadAppHotfixHelpers();
  const state = applyRecoveryState('manual-reconnect', 'expired');
  let timerScheduled = false;

  if (isAutomaticReconnectAllowed(state)) timerScheduled = true;

  assert.equal(timerScheduled, false);
});

test('captured reconnect callback stays blocked after a late expired recovery state', () => {
  const { applyRecoveryState, runAutomaticReconnect } = loadAppHotfixHelpers();
  let state = 'manual-reconnect';
  let reconnectCalls = 0;
  const capturedCallback = () => runAutomaticReconnect({
    sessionState: state,
    roomCode: '1234',
    reconnect: () => { reconnectCalls += 1; }
  });

  state = applyRecoveryState(state, 'expired');

  assert.equal(capturedCallback(), false);
  assert.equal(reconnectCalls, 0);
});

test('recovery state changes remain active without a manual pairing guard', () => {
  const { applyRecoveryState } = loadAppHotfixHelpers();

  assert.equal(applyRecoveryState('paired', 'signaling-disconnected'), 'signaling-disconnected');
  assert.equal(applyRecoveryState('signaling-disconnected', 'recovering'), 'recovering');
  assert.equal(applyRecoveryState('recovering', 'expired'), 'expired');
});

test('manual reconnect guard releases through delivery, pairing, and reset lifecycle', () => {
  const { isAutomaticReconnectAllowed, markManualActionDelivered } = loadAppHotfixHelpers();
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const deliveredState = markManualActionDelivered('manual-reconnect');

  assert.equal(deliveredState, 'manual-pairing');
  assert.equal(isAutomaticReconnectAllowed(deliveredState), false);
  assert.equal(isAutomaticReconnectAllowed('paired'), true);
  assert.equal(isAutomaticReconnectAllowed('unpaired'), true);
  assert.match(
    appSource,
    /onCodeGenerated = \(code\) => \{\s*sessionRecoveryState = markManualActionDelivered\(sessionRecoveryState\)/
  );
  assert.match(
    appSource,
    /if \(!recovered\) \{\s*sessionRecoveryState = markManualActionDelivered\(sessionRecoveryState\)/
  );
  assert.match(
    appSource,
    /function resetApp\([\s\S]{0,250}sessionRecoveryState = 'unpaired';/
  );
});

test('manual action pending cancels an existing reconnect timer', () => {
  const { clearAutomaticReconnect } = loadAppHotfixHelpers();
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const clearedTimers = [];

  const state = clearAutomaticReconnect(42, (timer) => clearedTimers.push(timer));

  assert.deepEqual(clearedTimers, [42]);
  assert.equal(state.timer, null);
  assert.match(
    appSource,
    /onManualActionPending = \(\) => \{[\s\S]{0,200}clearAutomaticReconnect\(reconnectTimer, clearTimeout\)/
  );
});

test('manual action pending resets reconnect attempts', () => {
  const { clearAutomaticReconnect } = loadAppHotfixHelpers();
  const state = clearAutomaticReconnect(null, () => assert.fail('no timer should be cleared'));

  assert.equal(state.attempts, 0);
});

test('automatic reconnect scheduling is forbidden during manual reconnect', () => {
  const { isAutomaticReconnectAllowed } = loadAppHotfixHelpers();
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  assert.equal(isAutomaticReconnectAllowed('manual-reconnect'), false);
  assert.match(
    appSource,
    /function scheduleReconnect\(\) \{\s*if \(!isAutomaticReconnectAllowed\(sessionRecoveryState\)\) return;/
  );
});

test('a captured reconnect callback is harmless after manual reconnect begins', () => {
  const { runAutomaticReconnect } = loadAppHotfixHelpers();
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  let sessionState = 'paired';
  let reconnectCalls = 0;
  const capturedCallback = () => runAutomaticReconnect({
    sessionState,
    roomCode: '1234',
    reconnect: () => { reconnectCalls += 1; }
  });

  sessionState = 'manual-reconnect';

  assert.equal(capturedCallback(), false);
  assert.equal(reconnectCalls, 0);
  assert.match(
    appSource,
    /reconnectTimer = setTimeout\(\(\) => \{[\s\S]{0,200}runAutomaticReconnect\(\{[\s\S]{0,200}sessionState: sessionRecoveryState/
  );
});

test('join UI rejects four-character non-numeric codes with invalid_code', () => {
  const { submitManualJoin } = loadAppHotfixHelpers();
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  for (const code of ['12ab', 'abcd', '1 23', '１２３４']) {
    const toasts = [];
    const accepted = submitManualJoin(code, {
      onInvalid: () => toasts.push('invalid_code'),
      onValid: () => assert.fail(`invalid code ${code} was accepted`)
    });

    assert.equal(accepted, false);
    assert.deepEqual(toasts, ['invalid_code']);
  }
  assert.match(
    appSource,
    /btnJoin\.addEventListener\('click',[\s\S]{0,150}const code = joinCodeInput\.value\.trim\(\);[\s\S]{0,80}submitManualJoin\(code/
  );
});

test('invalid join input does not update onboarding or call SocketManager', () => {
  const { submitManualJoin } = loadAppHotfixHelpers();
  let onboardingUpdates = 0;
  let joinCalls = 0;

  submitManualJoin('12ab', {
    onInvalid() {},
    onValid() {
      onboardingUpdates += 1;
      joinCalls += 1;
    }
  });

  assert.equal(onboardingUpdates, 0);
  assert.equal(joinCalls, 0);
});

test('valid four-digit join input reaches SocketManager and onboarding', () => {
  const { submitManualJoin } = loadAppHotfixHelpers();
  const joinedCodes = [];
  let onboardingStep = null;

  const accepted = submitManualJoin('2468', {
    onInvalid: () => assert.fail('valid code was rejected'),
    onValid(code) {
      onboardingStep = 2;
      joinedCodes.push(code);
    }
  });

  assert.equal(accepted, true);
  assert.equal(onboardingStep, 2);
  assert.deepEqual(joinedCodes, ['2468']);
});

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
    this.connected = false;
    this.connectCalls = 0;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, payload) {
    this.sent.push({ event, payload });
  }

  connect() {
    this.connectCalls += 1;
  }

  receive(event, payload) {
    if (event === 'connect') this.connected = true;
    if (event === 'disconnect') this.connected = false;
    this.handlers.get(event)?.(payload);
  }
}

function createSocketManager(socket = new FakeSocket(), options = {}) {
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => socket;
  const manager = new SocketManager(options);
  manager.connect();
  return {
    manager,
    socket,
    restore() {
      global.window = previousWindow;
      global.io = previousIo;
    }
  };
}

function establishRecoveringSession(manager, socket, role = 'initiator') {
  socket.receive('connect');
  socket.receive('paired', {
    role,
    code: '1234',
    recoveryToken: 'a'.repeat(64),
    recovered: false
  });
  socket.sent = [];
  socket.receive('disconnect', 'transport close');
}

function installFakeRtc() {
  const previousPeerConnection = global.RTCPeerConnection;
  const previousSessionDescription = global.RTCSessionDescription;
  const previousIceCandidate = global.RTCIceCandidate;
  const peers = [];

  class FakePeerConnection {
    constructor() {
      this.remoteDescription = null;
      this.candidates = [];
      this.answers = 0;
      peers.push(this);
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }

    async createAnswer() {
      this.answers += 1;
      return { type: 'answer', sdp: 'answer' };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async addIceCandidate(candidate) {
      this.candidates.push(candidate);
    }

    close() {}
  }

  global.RTCPeerConnection = FakePeerConnection;
  global.RTCSessionDescription = function FakeRTCSessionDescription(description) {
    return description;
  };
  global.RTCIceCandidate = function FakeRTCIceCandidate(candidate) {
    return candidate;
  };

  return {
    peers,
    restore() {
      global.RTCPeerConnection = previousPeerConnection;
      global.RTCSessionDescription = previousSessionDescription;
      global.RTCIceCandidate = previousIceCandidate;
    }
  };
}

function waitForAsyncSignals() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createNegotiationDeadlineHarness() {
  const timers = new Map();
  const cleared = [];
  let nextTimer = 0;
  const manager = new WebRTCManager(
    { sendSignal() {}, sendRelayUsage() {} },
    {
      negotiationTimeout: 25,
      setTimeoutFn(callback, delay) {
        const timer = { id: ++nextTimer, callback, delay };
        timers.set(timer.id, timer);
        return timer;
      },
      clearTimeoutFn(timer) {
        cleared.push(timer.id);
        timers.delete(timer.id);
      }
    }
  );
  return { manager, timers, cleared };
}

function startNegotiationAttempt(manager, connectionState = 'new') {
  const peer = {
    connectionState,
    closed: 0,
    close() {
      this.closed += 1;
    }
  };
  manager.peerConnection = peer;
  const generation = ++manager.peerConnectionGeneration;
  manager.negotiationActive = true;
  manager.armNegotiationDeadline(peer, generation);
  return { peer, generation, timer: manager.negotiationTimer };
}

function createNegotiationRuntimeHarness(channelState = 'connecting') {
  const previousPeerConnection = global.RTCPeerConnection;
  const { manager, timers, cleared } = createNegotiationDeadlineHarness();
  const peers = [];

  class DeadlinePeerConnection {
    constructor() {
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.closed = 0;
      peers.push(this);
    }

    close() {
      this.closed += 1;
      this.connectionState = 'closed';
    }
  }

  const channel = {
    readyState: channelState,
    bufferedAmountLowThreshold: 0,
    binaryType: null,
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
      this.readyState = 'closed';
      this.onclose?.();
    },
    open() {
      this.readyState = 'open';
      return this.onopen?.();
    }
  };

  global.RTCPeerConnection = DeadlinePeerConnection;
  manager.rtcConfig = { iceServers: [] };
  manager.createPeerConnection();

  return {
    manager,
    timers,
    cleared,
    peers,
    peer: manager.peerConnection,
    channel,
    timer: manager.negotiationTimer,
    attachChannel() {
      manager.setDataChannel(channel);
      return channel;
    },
    restore() {
      global.RTCPeerConnection = previousPeerConnection;
    }
  };
}

for (const frozenState of ['new', 'connecting']) {
  test(`WebRTC negotiation deadline retires a peer frozen in ${frozenState}`, () => {
    const { manager } = createNegotiationDeadlineHarness();
    const failures = [];
    manager.onConnectionStateChange = (state, details) => failures.push({ state, details });
    const { peer, timer } = startNegotiationAttempt(manager, frozenState);

    timer.callback();

    assert.equal(peer.closed, 1);
    assert.equal(manager.peerConnection, null);
    assert.equal(manager.negotiationTimer, null);
    assert.equal(manager.negotiationActive, false);
    assert.deepEqual(failures, [{
      state: 'failed',
      details: { code: 'WEBRTC_NEGOTIATION_TIMEOUT' }
    }]);
  });
}

test('clearing the current negotiation deadline invalidates its captured timeout', () => {
  const { manager, timers } = createNegotiationDeadlineHarness();
  let failures = 0;
  manager.onConnectionStateChange = () => { failures += 1; };
  const { generation, timer } = startNegotiationAttempt(manager);

  assert.equal(manager.clearNegotiationDeadline(generation), true);
  timer.callback();

  assert.equal(timers.size, 0);
  assert.equal(failures, 0);
  assert.notEqual(manager.peerConnection, null);
});

test('connected peer with a connecting DataChannel still reaches the negotiation deadline', () => {
  const harness = createNegotiationRuntimeHarness();
  const states = [];
  harness.manager.onConnectionStateChange = (state, details) => states.push({ state, details });
  harness.attachChannel();

  harness.peer.connectionState = 'connected';
  harness.peer.onconnectionstatechange();

  assert.equal(harness.manager.negotiationTimer, harness.timer);
  assert.deepEqual(states, []);
  harness.timer.callback();

  assert.equal(harness.peer.closed, 1);
  assert.equal(harness.channel.closeCalls, 1);
  assert.equal(harness.manager.peerConnection, null);
  assert.deepEqual(states, [{
    state: 'failed',
    details: { code: 'WEBRTC_NEGOTIATION_TIMEOUT' }
  }]);
  harness.restore();
});

test('DataChannel open after peer connection cancels the current deadline', () => {
  const harness = createNegotiationRuntimeHarness();
  const states = [];
  harness.manager.onConnectionStateChange = (state) => states.push(state);
  harness.attachChannel();

  harness.peer.connectionState = 'connected';
  harness.peer.onconnectionstatechange();
  assert.equal(harness.manager.negotiationTimer, harness.timer);

  assert.equal(harness.channel.open(), true);
  assert.equal(harness.manager.negotiationTimer, null);
  assert.equal(harness.manager.negotiationActive, false);
  harness.timer.callback();

  assert.equal(harness.peer.closed, 0);
  assert.deepEqual(states, ['connected']);
  harness.restore();
});

test('a DataChannel that opens immediately completes negotiation once', () => {
  const harness = createNegotiationRuntimeHarness();
  const states = [];
  harness.manager.onConnectionStateChange = (state) => states.push(state);

  harness.attachChannel();
  assert.equal(harness.channel.open(), true);

  assert.equal(harness.manager.negotiationTimer, null);
  assert.equal(harness.manager.negotiationActive, false);
  assert.deepEqual(states, ['connected']);
  assert.equal(harness.channel.onopen(), false);
  assert.deepEqual(states, ['connected']);
  harness.restore();
});

test('late open from a replaced channel cannot cancel the new generation deadline', () => {
  const first = createNegotiationRuntimeHarness();
  first.attachChannel();
  const oldOpen = first.channel.onopen;

  first.manager.createPeerConnection();
  const replacementPeer = first.manager.peerConnection;
  const replacementTimer = first.manager.negotiationTimer;
  const replacementChannel = {
    readyState: 'connecting',
    bufferedAmountLowThreshold: 0,
    close() {},
    open() {
      this.readyState = 'open';
      return this.onopen?.();
    }
  };
  first.manager.setDataChannel(replacementChannel);

  first.channel.readyState = 'open';
  assert.equal(oldOpen(), false);
  assert.equal(first.manager.peerConnection, replacementPeer);
  assert.equal(first.manager.negotiationTimer, replacementTimer);

  assert.equal(replacementChannel.open(), true);
  assert.equal(first.manager.negotiationTimer, null);
  first.restore();
});

test('obsolete timeout after a new peer and channel cannot terminate the replacement', () => {
  const harness = createNegotiationRuntimeHarness();
  harness.attachChannel();
  const oldTimer = harness.timer;

  harness.manager.createPeerConnection();
  const replacementPeer = harness.manager.peerConnection;
  const replacementTimer = harness.manager.negotiationTimer;
  oldTimer.callback();

  assert.equal(harness.manager.peerConnection, replacementPeer);
  assert.equal(harness.manager.negotiationTimer, replacementTimer);
  assert.equal(replacementPeer.closed, 0);
  harness.restore();
});

test('DataChannel negotiation timeout performs cleanup and recovery exactly once', () => {
  const harness = createNegotiationRuntimeHarness();
  const failures = [];
  let deliveryRejections = 0;
  let resumeRejections = 0;
  harness.manager.onConnectionStateChange = (state, details) => failures.push({ state, details });
  harness.manager.rejectAllDeliveryWaiters = () => {
    deliveryRejections += 1;
  };
  harness.manager.rejectAllResumeWaiters = () => {
    resumeRejections += 1;
  };
  harness.attachChannel();

  harness.peer.connectionState = 'connected';
  harness.peer.onconnectionstatechange();
  harness.timer.callback();
  harness.timer.callback();
  harness.channel.onclose?.();

  assert.equal(harness.peer.closed, 1);
  assert.equal(deliveryRejections, 1);
  assert.equal(resumeRejections, 1);
  assert.deepEqual(failures, [{
    state: 'failed',
    details: { code: 'WEBRTC_NEGOTIATION_TIMEOUT' }
  }]);
  harness.restore();
});

test('replacement negotiation invalidates a captured timeout from the previous peer', () => {
  const { manager } = createNegotiationDeadlineHarness();
  let failures = 0;
  manager.onConnectionStateChange = () => { failures += 1; };
  const first = startNegotiationAttempt(manager);
  const second = startNegotiationAttempt(manager, 'connecting');

  first.timer.callback();

  assert.equal(first.peer.closed, 0);
  assert.equal(manager.peerConnection, second.peer);
  assert.equal(manager.negotiationTimer, second.timer);
  assert.equal(failures, 0);
});

test('late duplicate negotiation timeout performs cleanup and notification once', () => {
  const { manager } = createNegotiationDeadlineHarness();
  let failures = 0;
  manager.onConnectionStateChange = () => { failures += 1; };
  const { peer, timer } = startNegotiationAttempt(manager);

  timer.callback();
  timer.callback();

  assert.equal(peer.closed, 1);
  assert.equal(failures, 1);
});

test('negotiation timeout feeds the bounded application reconnect path', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  assert.match(
    appSource,
    /state === 'failed'[\s\S]{0,250}scheduleReconnect\(\)/
  );
  assert.match(
    appSource,
    /reconnectAttempts >= maxReconnectAttempts[\s\S]{0,200}resetApp\(\)/
  );
});

test('a recovered offer queued before reconnect creates an answer on the replacement peer', async () => {
  const rtc = installFakeRtc();
  const sentSignals = [];
  const manager = new WebRTCManager({
    sendSignal: (room, data) => sentSignals.push({ room, data }),
    sendRelayUsage() {}
  });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'receiver';
  manager.roomCode = '1234';

  try {
    manager.prepareForRecovery();
    await manager.handleSignal({ type: 'offer', offer: { type: 'offer', sdp: 'recovered' } });
    assert.equal(manager.peerConnection, null);
    assert.equal(manager.pendingSignals.length, 1);

    assert.equal(manager.reconnect(), true);
    await waitForAsyncSignals();

    assert.equal(rtc.peers.length, 1);
    assert.equal(rtc.peers[0].remoteDescription.sdp, 'recovered');
    assert.equal(rtc.peers[0].answers, 1);
    assert.deepEqual(sentSignals.filter(({ data }) => data.type === 'answer'), [{
      room: '1234',
      data: { type: 'answer', answer: { type: 'answer', sdp: 'answer' } }
    }]);
  } finally {
    rtc.restore();
  }
});

test('recovered ICE candidates queued before reconnect are processed after the offer', async () => {
  const rtc = installFakeRtc();
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'receiver';
  manager.roomCode = '1234';

  try {
    manager.prepareForRecovery();
    await manager.handleSignal({ type: 'candidate', candidate: { candidate: 'current' } });
    await manager.handleSignal({ type: 'offer', offer: { type: 'offer', sdp: 'recovered' } });
    manager.reconnect();
    await waitForAsyncSignals();

    assert.deepEqual(rtc.peers[0].candidates, [{ candidate: 'current' }]);
    assert.equal(manager.pendingRemoteCandidates.length, 0);
  } finally {
    rtc.restore();
  }
});

test('stale queued signals from a previous recovery generation remain discarded', async () => {
  const rtc = installFakeRtc();
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'receiver';
  manager.roomCode = '1234';

  try {
    manager.prepareForRecovery();
    await manager.handleSignal({ type: 'offer', offer: { type: 'offer', sdp: 'stale' } });
    manager.recoveryPrepared = false;
    manager.prepareForRecovery();
    assert.equal(manager.pendingSignals.length, 0);

    await manager.handleSignal({ type: 'offer', offer: { type: 'offer', sdp: 'current' } });
    manager.reconnect();
    await waitForAsyncSignals();

    assert.equal(rtc.peers[0].remoteDescription.sdp, 'current');
    assert.equal(rtc.peers[0].answers, 1);
  } finally {
    rtc.restore();
  }
});

test('reconnect flushes current signals before an initiator starts a new offer', () => {
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'initiator';
  manager.roomCode = '1234';
  manager.prepareForRecovery();
  const order = [];
  manager.createPeerConnection = () => {
    manager.peerConnection = {};
    order.push('peer');
  };
  manager.flushPendingSignals = () => order.push('flush');
  manager.createDataChannel = () => order.push('channel');
  manager.createOffer = () => order.push('offer');

  assert.equal(manager.reconnect(), true);
  assert.deepEqual(order, ['peer', 'flush', 'channel', 'offer']);
});

test('receiver-initiated reconnect requests one restart from the initiator', () => {
  const signals = [];
  const manager = new WebRTCManager({
    sendSignal: (room, data) => signals.push({ room, data }),
    sendRelayUsage() {}
  });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'receiver';
  manager.roomCode = '1234';
  manager.prepareForRecovery();
  manager.createPeerConnection = () => {
    manager.peerConnection = {};
  };
  manager.flushPendingSignals = () => {};

  assert.equal(manager.reconnect(), true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].room, '1234');
  assert.equal(signals[0].data.type, 'restart-request');
  assert.match(signals[0].data.requestId, /^restart-\d+-\d+$/);
});

test('initiator responds to a receiver restart request with exactly one negotiation', () => {
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'initiator';
  manager.roomCode = '1234';
  manager.peerConnection = {};
  let reconnects = 0;
  manager.reconnect = () => {
    reconnects += 1;
    manager.negotiationActive = true;
    return true;
  };
  const request = { type: 'restart-request', requestId: 'restart-1-1' };

  assert.equal(manager.handleRestartRequest(request), true);
  assert.equal(manager.handleRestartRequest(request), false);
  assert.equal(reconnects, 1);
  assert.equal(manager.negotiationActive, true);
});

test('simultaneous recovery does not create a second initiator offer', () => {
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.role = 'initiator';
  manager.roomCode = '1234';
  manager.negotiationActive = true;
  let reconnects = 0;
  manager.reconnect = () => {
    reconnects += 1;
    return true;
  };

  assert.equal(manager.handleRestartRequest({
    type: 'restart-request',
    requestId: 'restart-1-simultaneous'
  }), false);
  assert.equal(reconnects, 0);
});

test('a queued restart request from an obsolete signal generation is discarded', async () => {
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.role = 'initiator';
  manager.roomCode = '1234';
  let restartCalls = 0;
  manager.handleRestartRequest = () => {
    restartCalls += 1;
    return true;
  };

  await manager.handleSignal({
    type: 'restart-request',
    requestId: 'restart-stale-generation'
  });
  assert.equal(manager.pendingSignals.length, 1);

  manager.prepareForRecovery();
  manager.peerConnection = {};
  manager.flushPendingSignals();
  await waitForAsyncSignals();

  assert.equal(restartCalls, 0);
});

test('receiver does not request a restart when a current initiator offer is already queued', async () => {
  const rtc = installFakeRtc();
  const sentSignals = [];
  const manager = new WebRTCManager({
    sendSignal: (room, data) => sentSignals.push({ room, data }),
    sendRelayUsage() {}
  });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'receiver';
  manager.roomCode = '1234';

  try {
    manager.prepareForRecovery();
    await manager.handleSignal({ type: 'offer', offer: { type: 'offer', sdp: 'current' } });
    manager.reconnect();
    await waitForAsyncSignals();

    assert.equal(sentSignals.filter(({ data }) => data.type === 'restart-request').length, 0);
    assert.equal(sentSignals.filter(({ data }) => data.type === 'answer').length, 1);
  } finally {
    rtc.restore();
  }
});

test('handling a restart request replaces the previous peer before negotiating', () => {
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.rtcConfig = { iceServers: [] };
  manager.role = 'initiator';
  manager.roomCode = '1234';
  let oldPeerClosed = 0;
  const oldPeer = { close: () => { oldPeerClosed += 1; } };
  manager.peerConnection = oldPeer;
  manager.createPeerConnection = () => {
    manager.peerConnection = { replacement: true };
  };
  manager.createDataChannel = () => {};
  manager.createOffer = () => {
    manager.negotiationActive = true;
  };

  assert.equal(manager.handleRestartRequest({
    type: 'restart-request',
    requestId: 'restart-replace-peer'
  }), true);
  assert.equal(oldPeerClosed, 1);
  assert.equal(manager.peerConnection.replacement, true);
  assert.equal(manager.negotiationActive, true);
});

test('generate while Socket.IO is disconnected retains recovery until reconnect', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    const token = context.manager.recovery.session.recoveryToken;
    const pendingStates = [];
    context.manager.onManualActionPending = ({ type }) => pendingStates.push(type);

    assert.equal(context.manager.generateCode(), false);
    assert.equal(context.manager.recovery.session.recoveryToken, token);
    assert.equal(context.manager.pendingManualAction.type, 'generate');
    assert.equal(context.socket.sent.some(({ event }) => event === 'generate-code'), false);
    assert.deepEqual(pendingStates, ['generate']);
    assert.equal(context.socket.connectCalls, 1);
  } finally {
    context.restore();
  }
});

test('join while Socket.IO is disconnected retains recovery and validates the code', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket, 'receiver');
    const token = context.manager.recovery.session.recoveryToken;

    assert.equal(context.manager.joinCode(' 2468 '), false);
    assert.equal(context.manager.recovery.session.recoveryToken, token);
    assert.deepEqual(context.manager.pendingManualAction, { type: 'join', code: '2468' });
    assert.equal(context.manager.joinCode('12ab'), false);
    assert.deepEqual(context.manager.pendingManualAction, { type: 'join', code: '2468' });
  } finally {
    context.restore();
  }
});

test('a pending manual action is emitted exactly once after connect', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    context.manager.generateCode();
    context.socket.receive('connect');
    context.socket.receive('connect');

    assert.equal(context.socket.sent.filter(({ event }) => event === 'generate-code').length, 1);
    assert.equal(context.socket.sent.filter(({ event }) => event === 'recover-session').length, 0);
    assert.equal(context.manager.pendingManualAction, null);
    assert.equal(context.manager.recovery.session, null);
  } finally {
    context.restore();
  }
});

test('a later join replaces a pending generate action', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    context.manager.generateCode();
    context.manager.joinCode('2468');
    assert.equal(context.socket.connectCalls, 1);

    context.socket.receive('connect');
    assert.equal(context.socket.sent.filter(({ event }) => event === 'generate-code').length, 0);
    assert.deepEqual(
      context.socket.sent.filter(({ event }) => event === 'join-code'),
      [{ event: 'join-code', payload: { code: '2468' } }]
    );
  } finally {
    context.restore();
  }
});

test('an interrupted manual emit retains the recovery credential and pending action', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    context.socket.receive('connect');
    context.socket.sent = [];
    const token = context.manager.recovery.session.recoveryToken;
    const originalEmit = context.socket.emit.bind(context.socket);
    let interruptJoin = true;
    context.socket.emit = (event, payload) => {
      if (event === 'join-code' && interruptJoin) {
        interruptJoin = false;
        throw new Error('transport interrupted');
      }
      originalEmit(event, payload);
    };

    assert.equal(context.manager.joinCode('2468'), false);
    assert.equal(context.manager.recovery.session.recoveryToken, token);
    assert.deepEqual(context.manager.pendingManualAction, { type: 'join', code: '2468' });

    context.socket.receive('disconnect', 'transport close');
    context.socket.receive('connect');
    assert.equal(context.socket.sent.filter(({ event }) => event === 'join-code').length, 1);
    assert.equal(context.socket.sent.filter(({ event }) => event === 'recover-session').length, 0);
    assert.equal(context.manager.pendingManualAction, null);
    assert.equal(context.manager.recovery.session, null);
  } finally {
    context.restore();
  }
});

test('a failed pending abandonment blocks the new room action until ordered retry', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    context.manager.leaveRoom();
    context.manager.joinCode('2468');
    const originalEmit = context.socket.emit.bind(context.socket);
    let interruptAbandon = true;
    context.socket.emit = (event, payload) => {
      if (event === 'abandon-recovery' && interruptAbandon) {
        interruptAbandon = false;
        throw new Error('transport interrupted');
      }
      originalEmit(event, payload);
    };

    context.socket.receive('connect');
    assert.equal(context.socket.sent.some(({ event }) => event === 'join-code'), false);
    assert.notEqual(context.manager.pendingAbandonSession, null);
    assert.deepEqual(context.manager.pendingManualAction, { type: 'join', code: '2468' });

    context.socket.receive('disconnect', 'transport close');
    context.socket.receive('connect');
    const orderedEvents = context.socket.sent
      .filter(({ event }) => event === 'abandon-recovery' || event === 'join-code')
      .map(({ event }) => event);
    assert.deepEqual(orderedEvents, ['abandon-recovery', 'join-code']);
    assert.equal(context.manager.pendingAbandonSession, null);
    assert.equal(context.manager.pendingManualAction, null);
  } finally {
    context.restore();
  }
});

test('a successful connected replacement cannot replay the older pending action', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    context.socket.receive('connect');
    context.socket.sent = [];
    const originalEmit = context.socket.emit.bind(context.socket);
    let interruptJoin = true;
    context.socket.emit = (event, payload) => {
      if (event === 'join-code' && interruptJoin) {
        interruptJoin = false;
        throw new Error('transport interrupted');
      }
      originalEmit(event, payload);
    };

    context.manager.joinCode('2468');
    assert.deepEqual(context.manager.pendingManualAction, { type: 'join', code: '2468' });
    assert.equal(context.manager.generateCode(), true);
    assert.equal(context.manager.pendingManualAction, null);

    context.socket.receive('disconnect', 'transport close');
    context.socket.receive('connect');
    assert.equal(context.socket.sent.filter(({ event }) => event === 'generate-code').length, 1);
    assert.equal(context.socket.sent.filter(({ event }) => event === 'join-code').length, 0);
  } finally {
    context.restore();
  }
});

test('online recovery explicitly reconnects the existing Socket.IO instance', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    assert.equal(context.manager.ensureConnected(), false);
    assert.equal(context.manager.ensureConnected(), false);
    assert.equal(context.socket.connectCalls, 1);

    const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    assert.match(
      appSource,
      /window\.addEventListener\('online',[\s\S]{0,200}socketManager\.ensureConnected\(\)/
    );
  } finally {
    context.restore();
  }
});

test('online plus automatic Socket.IO reconnect submits recovery only once', () => {
  const context = createSocketManager();
  try {
    establishRecoveringSession(context.manager, context.socket);
    context.manager.ensureConnected();
    context.socket.receive('connect');
    context.socket.receive('connect');

    assert.equal(context.socket.connectCalls, 1);
    assert.equal(context.socket.sent.filter(({ event }) => event === 'recover-session').length, 1);
  } finally {
    context.restore();
  }
});

test('manual pairing after recovery failure works without replacing the Socket.IO instance', () => {
  const context = createSocketManager();
  try {
    context.socket.receive('connect');
    context.manager.recovery.establish({
      recoveryToken: 'b'.repeat(64), code: '1234', role: 'receiver'
    });
    context.manager.recovery.markRecovering();
    context.manager.recovery.fail();
    context.socket.sent = [];

    assert.equal(context.manager.joinCode('2468'), true);
    assert.deepEqual(context.socket.sent, [{ event: 'join-code', payload: { code: '2468' } }]);
    assert.equal(context.manager.socket, context.socket);
  } finally {
    context.restore();
  }
});

test('late recovered pairing cannot overwrite a queued manual pairing', () => {
  const context = createSocketManager();
  try {
    let recovered = 0;
    context.manager.onPaired = (data) => { if (data.recovered) recovered += 1; };
    establishRecoveringSession(context.manager, context.socket);
    context.manager.joinCode('2468');
    context.socket.receive('connect');
    context.socket.receive('paired', {
      role: 'initiator', code: '1234', recovered: true
    });

    assert.equal(recovered, 0);
    assert.equal(context.manager.recovery.state, 'unpaired');
    assert.deepEqual(context.socket.sent.at(-2), { event: 'join-code', payload: { code: '2468' } });
  } finally {
    context.restore();
  }
});

test('all late recovery events are ignored before and after the new manual room pairs', () => {
  const context = createSocketManager();
  try {
    let recoveredPairs = 0;
    let waiting = 0;
    let failures = 0;
    context.manager.onPaired = ({ recovered }) => { if (recovered) recoveredPairs += 1; };
    context.manager.onRecoveryWaiting = () => { waiting += 1; };
    context.manager.onRecoveryFailed = () => { failures += 1; };
    establishRecoveringSession(context.manager, context.socket);
    context.manager.joinCode('2468');
    context.socket.receive('connect');

    const sendLateRecoveryEvents = () => {
      context.socket.receive('paired', { role: 'initiator', code: '1234', recovered: true });
      context.socket.receive('recovery-token', { recoveryToken: 'f'.repeat(64) });
      context.socket.receive('recovery-waiting');
      context.socket.receive('recovery-failed', { message: 'CONNECT_FAILED' });
    };

    sendLateRecoveryEvents();
    assert.deepEqual({ recoveredPairs, waiting, failures }, { recoveredPairs: 0, waiting: 0, failures: 0 });
    assert.equal(context.manager.recovery.state, 'unpaired');

    context.socket.receive('paired', {
      role: 'receiver', code: '2468', recoveryToken: 'b'.repeat(64), recovered: false
    });
    sendLateRecoveryEvents();
    assert.deepEqual({ recoveredPairs, waiting, failures }, { recoveredPairs: 0, waiting: 0, failures: 0 });
    assert.deepEqual(context.manager.recovery.session, {
      role: 'receiver', code: '2468', recoveryToken: 'b'.repeat(64)
    });
  } finally {
    context.restore();
  }
});

test('a stale recovery timeout cannot clear a newly paired manual room', () => {
  let staleTimeout = null;
  const context = createSocketManager(new FakeSocket(), {
    setTimeoutFn(callback) {
      staleTimeout = callback;
      return 1;
    },
    clearTimeoutFn() {}
  });
  try {
    context.socket.receive('connect');
    context.socket.receive('paired', {
      role: 'initiator', code: '1234', recoveryToken: 'a'.repeat(64), recovered: false
    });
    context.socket.receive('peer-disconnected', { recoverable: true });
    assert.equal(typeof staleTimeout, 'function');

    context.manager.joinCode('2468');
    context.socket.receive('paired', {
      role: 'receiver', code: '2468', recoveryToken: 'b'.repeat(64), recovered: false
    });
    staleTimeout();

    assert.equal(context.manager.recovery.state, 'paired');
    assert.equal(context.manager.recovery.session.code, '2468');
  } finally {
    context.restore();
  }
});

test('a fresh manual pairing discards signals queued after the prior session closed', async () => {
  const rtc = installFakeRtc();
  const manager = new WebRTCManager({ sendSignal() {}, sendRelayUsage() {} });
  manager.rtcConfig = { iceServers: [] };
  manager.encryption.available = false;

  try {
    manager.close();
    manager.encryption.available = false;
    await manager.handleSignal({ type: 'offer', offer: { type: 'offer', sdp: 'stale' } });
    assert.equal(manager.pendingSignals.length, 1);

    manager.prepareForNewPairingSignals();
    assert.equal(manager.pendingSignals.length, 0);
    await manager.handleSignal({ type: 'offer', offer: { type: 'offer', sdp: 'current' } });
    manager.initialize('receiver', '2468');
    await waitForAsyncSignals();

    assert.equal(rtc.peers[0].remoteDescription.sdp, 'current');
    const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    assert.match(appSource, /if \(!recovered\) \{[\s\S]{0,100}webrtcManager\.prepareForNewPairingSignals\(\)/);
    assert.match(appSource, /if \(!activeSocketGeneration \|\| connectionGeneration !== activeSocketGeneration\) return;/);
  } finally {
    rtc.restore();
  }
});

for (const action of [
  { name: 'generate-code', invoke: (manager) => manager.generateCode() },
  { name: 'join-code', invoke: (manager) => manager.joinCode('2468') }
]) {
  test(`reset while disconnected followed by ${action.name} succeeds after reconnect`, () => {
    const context = createSocketManager();
    try {
      establishRecoveringSession(context.manager, context.socket);
      context.manager.leaveRoom();
      assert.equal(context.manager.recovery.session, null);
      action.invoke(context.manager);
      context.socket.receive('connect');

      const events = context.socket.sent.map(({ event }) => event);
      assert.equal(events.filter((event) => event === action.name).length, 1);
      assert.equal(events.indexOf('abandon-recovery') < events.indexOf(action.name), true);
    } finally {
      context.restore();
    }
  });
}

test('Service Worker activation does not unconditionally reload an active page', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

  assert.match(appSource, /function canApplyPwaUpdate\(\)[\s\S]*!transferIsActive/);
  assert.match(appSource, /if \(!canApplyPwaUpdate\(\)\)[\s\S]*pwaUpdateDeferred = true/);
  assert.match(workerSource, /event\.data\?\.type === 'SKIP_WAITING'/);
  assert.match(workerSource, /await self\.clients\.claim\(\)/);
  assert.doesNotMatch(`${appSource}\n${workerSource}`, /location\.reload\(/);
});
