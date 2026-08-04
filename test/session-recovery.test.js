'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PairingSecurity } = require('../pairing-security');
const { SocketManager, SessionRecoveryState } = require('../public/js/socket-manager');
const WebRTCManager = require('../public/js/webrtc-manager');

const ROOT = path.join(__dirname, '..');

function createSecurity() {
  let tokenByte = 1;
  return new PairingSecurity({
    randomBytes: () => Buffer.alloc(32, tokenByte++)
  });
}

function createPairedRoom(code = '1234') {
  const security = createSecurity();
  security.createRoom(code, 'socket-initiator', null);
  const joined = security.attemptJoin(code, 'socket-receiver');
  const participants = Array.from(joined.room.participants.values());
  return {
    security,
    room: joined.room,
    initiator: participants.find((participant) => participant.role === 'initiator'),
    receiver: participants.find((participant) => participant.role === 'receiver')
  };
}

function createFakeTimers() {
  const scheduled = new Map();
  let nextId = 1;
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) {
      scheduled.delete(id);
    },
    runNext() {
      const [id, timer] = scheduled.entries().next().value || [];
      if (!timer) return false;
      scheduled.delete(id);
      timer.callback();
      return true;
    },
    nextCallback() {
      return scheduled.values().next().value?.callback || null;
    },
    get size() {
      return scheduled.size;
    }
  };
}

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
    this.connected = true;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, payload) {
    this.sent.push({ event, payload });
  }

  receive(event, payload) {
    this.handlers.get(event)?.(payload);
  }
}

class FakeDataChannel {
  constructor(onSend = null) {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.sent = [];
    this.onSend = onSend;
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('closed');
    this.sent.push(data);
    this.onSend?.(data);
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

function createRtcManager() {
  const manager = new WebRTCManager({ sendSignal() {} });
  manager.encryption.available = false;
  manager.rtcConfig = { iceServers: [] };
  return manager;
}

test('signaling disconnect followed by the legitimate participant restores the paired room', () => {
  const { security, room, initiator } = createPairedRoom();
  const disconnected = security.markSocketDisconnected('socket-initiator');
  assert.equal(disconnected.recoverable, true);
  assert.equal(room.state, 'recovering');

  const recovered = security.recoverSession(initiator.recoveryToken, 'socket-initiator-new');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.ready, true);
  assert.equal(room.state, 'paired');
  assert.deepEqual(room.occupants, new Set(['socket-receiver', 'socket-initiator-new']));
});

test('sender can reconnect first and waits for the receiver', () => {
  const { security, room, initiator, receiver } = createPairedRoom();
  security.markSocketDisconnected('socket-initiator');
  security.markSocketDisconnected('socket-receiver');

  const first = security.recoverSession(initiator.recoveryToken, 'initiator-new');
  assert.equal(first.ready, false);
  assert.equal(room.state, 'recovering');
  const second = security.recoverSession(receiver.recoveryToken, 'receiver-new');
  assert.equal(second.ready, true);
  assert.equal(room.state, 'paired');
});

test('receiver can reconnect first and waits for the sender', () => {
  const { security, room, initiator, receiver } = createPairedRoom();
  security.markSocketDisconnected('socket-initiator');
  security.markSocketDisconnected('socket-receiver');

  assert.equal(security.recoverSession(receiver.recoveryToken, 'receiver-new').ready, false);
  assert.equal(security.recoverSession(initiator.recoveryToken, 'initiator-new').ready, true);
  assert.equal(room.state, 'paired');
});

test('both peers can reconnect nearly simultaneously without duplicating occupants', () => {
  const { security, room, initiator, receiver } = createPairedRoom();
  security.markSocketDisconnected('socket-initiator');
  security.markSocketDisconnected('socket-receiver');

  security.recoverSession(initiator.recoveryToken, 'initiator-new');
  const recoveredReceiver = security.recoverSession(receiver.recoveryToken, 'receiver-new');
  const duplicate = security.recoverSession(recoveredReceiver.recoveryToken, 'receiver-new');

  assert.equal(duplicate.alreadyConnected, true);
  assert.equal(room.occupants.size, 2);
});

test('one peer that never returns leaves a bounded recoverable room', () => {
  const { security, room } = createPairedRoom();
  security.markSocketDisconnected('socket-initiator');
  assert.equal(room.state, 'recovering');
  assert.equal(room.occupants.has('socket-receiver'), true);
});

test('room grace-period expiry destroys the room, tokens, and code', () => {
  const { security, room, initiator } = createPairedRoom();
  security.markSocketDisconnected('socket-initiator');
  const expired = security.expireRecoveringRoom('1234', room, room.recoveryGeneration, 100);

  assert.equal(expired, room);
  assert.equal(security.activeRooms.has('1234'), false);
  assert.equal(security.recoveryTokens.has(initiator.recoveryToken), false);
  assert.equal(security.invalidatedCodes.get('1234'), 100);
});

test('legitimate rejoin cancels the room recovery cleanup', () => {
  const { security, room, initiator } = createPairedRoom();
  security.markSocketDisconnected('socket-initiator');
  room.recoveryTimeout = setTimeout(() => {}, 60_000);
  room.recoveryTimeout.unref?.();

  assert.equal(security.recoverSession(initiator.recoveryToken, 'initiator-new').ready, true);
  assert.equal(room.recoveryTimeout, null);
  assert.equal(security.expireRecoveringRoom('1234', room, 100), null);
});

test('third-party recovery and token reuse while the participant is connected are rejected', () => {
  const { security, initiator } = createPairedRoom();
  assert.equal(security.recoverSession('f'.repeat(64), 'attacker').ok, false);
  assert.equal(security.recoverSession(initiator.recoveryToken, 'attacker').ok, false);
});

test('participant recovery credentials are distinct even when entropy briefly collides', () => {
  const values = [Buffer.alloc(32, 1), Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  const security = new PairingSecurity({ randomBytes: () => values.shift() });
  security.createRoom('1234', 'initiator', null);
  const { room } = security.attemptJoin('1234', 'receiver');
  const tokens = Array.from(room.participants.keys());
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
});

test('a stale socket cannot reclaim a participant after a legitimate rejoin', () => {
  const { security, initiator } = createPairedRoom();
  security.markSocketDisconnected('socket-initiator');
  security.recoverSession(initiator.recoveryToken, 'initiator-new');

  assert.equal(security.recoverSession(initiator.recoveryToken, 'socket-initiator').ok, false);
  assert.equal(security.socketRooms.has('socket-initiator'), false);
  assert.equal(security.socketRooms.get('initiator-new'), '1234');
});

test('successful acknowledgement activates the replacement and rejects the old token', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');

  const recovered = security.recoverSession(oldToken, 'initiator-new');
  assert.equal(recovered.ok, true);
  assert.notEqual(recovered.recoveryToken, oldToken);
  assert.equal(security.recoveryTokens.has(oldToken), true);
  assert.equal(security.acknowledgeRecoveryToken(
    recovered.recoveryToken,
    'initiator-new'
  ).ok, true);
  assert.equal(security.recoveryTokens.has(oldToken), false);
  assert.equal(security.recoverSession(oldToken, 'attacker').ok, false);
});

test('disconnect before replacement-token delivery preserves the last client-known token', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(oldToken, 'initiator-new');

  security.markSocketDisconnected('initiator-new');
  assert.equal(security.recoveryTokens.get(oldToken).state, 'active');
  assert.equal(security.recoveryTokens.get(recovered.recoveryToken).state, 'pending');
  assert.equal(initiator.socketId, null);
});

test('retry with the last client-known token succeeds after delivery loss', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const first = security.recoverSession(oldToken, 'initiator-new');
  security.markSocketDisconnected('initiator-new');

  const retry = security.recoverSession(oldToken, 'initiator-newer');
  assert.equal(retry.ok, true);
  assert.notEqual(retry.recoveryToken, first.recoveryToken);
  assert.equal(security.recoveryTokens.has(first.recoveryToken), false);
  assert.equal(security.recoveryTokens.has(oldToken), true);
});

test('delivered but unacknowledged replacement remains pending beside the active token', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(oldToken, 'initiator-new');

  assert.equal(initiator.recoveryToken, oldToken);
  assert.equal(initiator.pendingRecoveryToken, recovered.recoveryToken);
  assert.equal(security.recoveryTokens.get(oldToken).state, 'active');
  assert.equal(security.recoveryTokens.get(recovered.recoveryToken).state, 'pending');
});

test('duplicate recovery-token acknowledgement is idempotent', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(oldToken, 'initiator-new');

  const first = security.acknowledgeRecoveryToken(recovered.recoveryToken, 'initiator-new');
  const duplicate = security.acknowledgeRecoveryToken(recovered.recoveryToken, 'initiator-new');
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(security.recoveryTokens.size, 2);
});

test('a stale or disconnected socket cannot acknowledge a pending replacement', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(oldToken, 'initiator-new');
  security.markSocketDisconnected('initiator-new');

  assert.equal(security.acknowledgeRecoveryToken(
    recovered.recoveryToken,
    'initiator-new'
  ).ok, false);
  assert.equal(security.recoveryTokens.has(oldToken), true);
});

test('old and pending tokens cannot bind two sockets simultaneously', () => {
  const first = createPairedRoom();
  const oldToken = first.initiator.recoveryToken;
  first.security.markSocketDisconnected('socket-initiator');
  const handoff = first.security.recoverSession(oldToken, 'first-winner');
  first.security.markSocketDisconnected('first-winner');
  assert.equal(first.security.recoverSession(oldToken, 'old-winner').ok, true);
  assert.equal(first.security.recoverSession(handoff.recoveryToken, 'pending-loser').ok, false);

  const second = createPairedRoom();
  const secondOldToken = second.initiator.recoveryToken;
  second.security.markSocketDisconnected('socket-initiator');
  const secondHandoff = second.security.recoverSession(secondOldToken, 'first-winner');
  second.security.markSocketDisconnected('first-winner');
  assert.equal(second.security.recoverSession(secondHandoff.recoveryToken, 'pending-winner').ok, true);
  assert.equal(second.security.recoverSession(secondOldToken, 'old-loser').ok, false);
});

test('disconnect during a second rotation remains recoverable with the last stored token', () => {
  const { security, initiator } = createPairedRoom();
  const initialToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const first = security.recoverSession(initialToken, 'initiator-one');
  security.markSocketDisconnected('initiator-one');
  const second = security.recoverSession(first.recoveryToken, 'initiator-two');
  security.markSocketDisconnected('initiator-two');

  const third = security.recoverSession(first.recoveryToken, 'initiator-three');
  assert.equal(third.ok, true);
  assert.equal(security.recoveryTokens.has(second.recoveryToken), false);
  assert.equal(security.recoveryTokens.has(first.recoveryToken), true);
});

test('room expiry removes active and pending recovery tokens', () => {
  const { security, room, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(oldToken, 'initiator-new');
  const disconnected = security.markSocketDisconnected('initiator-new');

  assert.equal(security.expireRecoveringRoom(
    '1234', room, disconnected.recoveryGeneration, 100
  ), room);
  assert.equal(security.recoveryTokens.has(oldToken), false);
  assert.equal(security.recoveryTokens.has(recovered.recoveryToken), false);
});

test('explicit abandon during pending rotation removes every credential', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(oldToken, 'initiator-new');

  assert.equal(security.abandonRecovery(recovered.recoveryToken, 'initiator-new', 100).ok, true);
  assert.equal(security.recoveryTokens.has(oldToken), false);
  assert.equal(security.recoveryTokens.has(recovered.recoveryToken), false);
  assert.equal(security.activeRooms.has('1234'), false);
});

test('a participant token remains bound to its original role', () => {
  const { security, initiator, receiver } = createPairedRoom();
  const initiatorToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  security.markSocketDisconnected('socket-receiver');

  const recovered = security.recoverSession(initiatorToken, 'initiator-new');
  assert.equal(recovered.participant.role, 'initiator');
  assert.equal(receiver.socketId, null);
  assert.equal(security.getParticipantBySocket(recovered.room, 'initiator-new').role, 'initiator');
});

test('a destroyed-room token cannot recover a new room that reuses the code', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.destroyRoom('1234', 0);
  security.invalidatedCodes.clear();
  security.createRoom('1234', 'new-initiator', null);
  security.attemptJoin('1234', 'new-receiver');

  assert.equal(security.recoverSession(oldToken, 'attacker').ok, false);
});

test('a stale disconnect after recovery cannot detach the replacement socket', () => {
  const { security, room, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  security.recoverSession(oldToken, 'initiator-new');

  assert.equal(security.markSocketDisconnected('socket-initiator'), null);
  assert.equal(security.getParticipantBySocket(room, 'initiator-new').role, 'initiator');
  assert.equal(room.occupants.has('initiator-new'), true);
});

test('simultaneous attempts using one token settle exactly once', () => {
  const { security, initiator } = createPairedRoom();
  const token = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');

  const first = security.recoverSession(token, 'winner');
  const second = security.recoverSession(token, 'loser');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(security.socketRooms.get('winner'), '1234');
  assert.equal(security.socketRooms.has('loser'), false);
});

test('recovery generation prevents a stale grace timer from destroying a restored room', () => {
  const { security, room, initiator } = createPairedRoom();
  const token = initiator.recoveryToken;
  const disconnected = security.markSocketDisconnected('socket-initiator');
  security.recoverSession(token, 'initiator-new');

  assert.equal(
    security.expireRecoveringRoom('1234', room, disconnected.recoveryGeneration, 100),
    null
  );
  assert.equal(security.activeRooms.get('1234'), room);
});

test('recovery at the exact expiry boundary has one deterministic winner', () => {
  const first = createPairedRoom();
  const firstToken = first.initiator.recoveryToken;
  const firstDisconnect = first.security.markSocketDisconnected('socket-initiator');
  assert.equal(first.security.expireRecoveringRoom(
    '1234', first.room, firstDisconnect.recoveryGeneration, 100
  ), first.room);
  assert.equal(first.security.recoverSession(firstToken, 'too-late').ok, false);

  const second = createPairedRoom();
  const secondToken = second.initiator.recoveryToken;
  const secondDisconnect = second.security.markSocketDisconnected('socket-initiator');
  assert.equal(second.security.recoverSession(secondToken, 'just-in-time').ok, true);
  assert.equal(second.security.expireRecoveringRoom(
    '1234', second.room, secondDisconnect.recoveryGeneration, 100
  ), null);
});

test('disconnect recover disconnect creates a new independent grace generation', () => {
  const { security, room, initiator } = createPairedRoom();
  const firstToken = initiator.recoveryToken;
  const firstDisconnect = security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(firstToken, 'initiator-new');
  const secondDisconnect = security.markSocketDisconnected('initiator-new');

  assert.notEqual(secondDisconnect.recoveryGeneration, firstDisconnect.recoveryGeneration);
  assert.equal(security.expireRecoveringRoom(
    '1234', room, firstDisconnect.recoveryGeneration, 100
  ), null);
  assert.equal(security.recoverSession(recovered.recoveryToken, 'initiator-newer').ok, true);
});

test('concurrent expiry callbacks destroy and invalidate a room exactly once', () => {
  const { security, room } = createPairedRoom();
  const firstDisconnect = security.markSocketDisconnected('socket-initiator');
  security.markSocketDisconnected('socket-receiver');
  const generation = firstDisconnect.recoveryGeneration;

  assert.equal(security.expireRecoveringRoom('1234', room, generation, 100), room);
  assert.equal(security.expireRecoveringRoom('1234', room, generation, 101), null);
  assert.equal(security.invalidatedCodes.get('1234'), 100);
  assert.equal(security.recoveryTokens.size, 0);
});

test('recovery timeout is deterministic and clears local session identity', () => {
  const timers = createFakeTimers();
  const states = [];
  let timedOut = 0;
  const recovery = new SessionRecoveryState({
    timeoutMs: 500,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onStateChange: (state) => states.push(state),
    onTimeout: () => { timedOut += 1; }
  });
  recovery.establish({ recoveryToken: 'a'.repeat(64), code: '1234', role: 'initiator' });
  recovery.markSignalingDisconnected();
  recovery.markRecovering();

  assert.equal(timers.size, 1);
  assert.equal(timers.runNext(), true);
  assert.equal(recovery.state, 'recovery-failed');
  assert.equal(recovery.session, null);
  assert.equal(timedOut, 1);
  assert.deepEqual(states, ['paired', 'signaling-disconnected', 'recovering', 'recovery-failed']);
});

test('successful recovery clears the client recovery timeout', () => {
  const timers = createFakeTimers();
  const recovery = new SessionRecoveryState({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });
  const session = { recoveryToken: 'a'.repeat(64), code: '1234', role: 'receiver' };
  recovery.establish(session);
  recovery.markSignalingDisconnected();
  assert.equal(timers.size, 1);
  recovery.establish(session, true);
  assert.equal(recovery.state, 'recovering');
  recovery.completeRecovery();
  assert.equal(recovery.state, 'recovered');
  assert.equal(timers.size, 0);
});

test('Socket.IO reconnect automatically submits only the in-memory recovery token', () => {
  const socket = new FakeSocket();
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => socket;
  try {
    const manager = new SocketManager();
    manager.connect();
    socket.receive('connect');
    socket.receive('paired', {
      role: 'initiator', code: '1234', recoveryToken: 'a'.repeat(64), recovered: false
    });
    socket.connected = false;
    socket.receive('disconnect', 'transport close');
    socket.connected = true;
    socket.receive('connect');

    const recoveryEvent = socket.sent.findLast((entry) => entry.event === 'recover-session');
    assert.deepEqual(recoveryEvent, {
      event: 'recover-session',
      payload: { recoveryToken: 'a'.repeat(64) }
    });
    assert.equal(Object.hasOwn(recoveryEvent.payload, 'code'), false);
    manager.recovery.reset();
  } finally {
    global.window = previousWindow;
    global.io = previousIo;
  }
});

test('client stores a delivered replacement before acknowledging it', () => {
  const socket = new FakeSocket();
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => socket;
  try {
    const manager = new SocketManager();
    manager.connect();
    socket.receive('connect');
    socket.receive('paired', {
      role: 'initiator', code: '1234', recoveryToken: 'a'.repeat(64), recovered: false
    });
    socket.receive('disconnect', 'transport close');
    socket.receive('connect');

    let tokenAtAcknowledgement = null;
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event, payload) => {
      if (event === 'recovery-token-ack') {
        tokenAtAcknowledgement = manager.recovery.session.recoveryToken;
      }
      originalEmit(event, payload);
    };
    socket.receive('recovery-token', { recoveryToken: 'b'.repeat(64) });

    assert.equal(tokenAtAcknowledgement, 'b'.repeat(64));
    assert.equal(manager.recovery.session.recoveryToken, 'b'.repeat(64));
    assert.deepEqual(socket.sent.at(-1), {
      event: 'recovery-token-ack',
      payload: { recoveryToken: 'b'.repeat(64) }
    });
  } finally {
    global.window = previousWindow;
    global.io = previousIo;
  }
});

test('invalid token delivery is not stored or acknowledged', () => {
  const socket = new FakeSocket();
  const manager = new SocketManager();
  manager.socket = socket;
  manager.connectionGeneration = 1;
  manager.recoveryRequestGeneration = 1;
  manager.recovery.establish({ recoveryToken: 'a'.repeat(64), code: '1234', role: 'receiver' });
  manager.recovery.markRecovering();

  assert.equal(manager.storeRecoveryTokenAndAcknowledge('invalid', socket, 1), false);
  assert.equal(manager.recovery.session.recoveryToken, 'a'.repeat(64));
  assert.equal(socket.sent.some((entry) => entry.event === 'recovery-token-ack'), false);
});

test('duplicate token delivery is idempotently stored and acknowledged', () => {
  const socket = new FakeSocket();
  const manager = new SocketManager();
  manager.socket = socket;
  manager.connectionGeneration = 1;
  manager.recoveryRequestGeneration = 1;
  manager.recovery.establish({ recoveryToken: 'a'.repeat(64), code: '1234', role: 'receiver' });
  manager.recovery.markRecovering();

  assert.equal(manager.storeRecoveryTokenAndAcknowledge('b'.repeat(64), socket, 1), true);
  assert.equal(manager.storeRecoveryTokenAndAcknowledge('b'.repeat(64), socket, 1), true);
  assert.equal(manager.recovery.session.recoveryToken, 'b'.repeat(64));
  assert.equal(socket.sent.filter((entry) => entry.event === 'recovery-token-ack').length, 2);
});

test('events from an obsolete Socket.IO instance are ignored', () => {
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const sockets = [firstSocket, secondSocket];
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => sockets.shift();
  try {
    const manager = new SocketManager();
    let paired = 0;
    let signals = 0;
    let disconnected = 0;
    manager.onPaired = () => { paired += 1; };
    manager.onSignal = () => { signals += 1; };
    manager.onDisconnect = () => { disconnected += 1; };
    manager.connect();
    manager.connect();
    secondSocket.receive('connect');

    firstSocket.receive('paired', { role: 'receiver', code: '1234' });
    firstSocket.receive('recovery-token', { recoveryToken: 'f'.repeat(64) });
    firstSocket.receive('signal', { data: { type: 'candidate' } });
    firstSocket.receive('disconnect', 'stale transport');
    assert.deepEqual({ paired, signals, disconnected }, { paired: 0, signals: 0, disconnected: 0 });
    assert.equal(firstSocket.sent.some((entry) => entry.event === 'recovery-token-ack'), false);
  } finally {
    global.window = previousWindow;
    global.io = previousIo;
  }
});

test('manual pairing remains available after local recovery failure', () => {
  const socket = new FakeSocket();
  const manager = new SocketManager();
  manager.socket = socket;
  manager.recovery.establish({ recoveryToken: 'b'.repeat(64), code: '5678', role: 'receiver' });
  manager.recovery.fail();
  manager.joinCode('2468');

  assert.equal(manager.recovery.state, 'unpaired');
  assert.deepEqual(socket.sent.at(-1), { event: 'join-code', payload: { code: '2468' } });
});

test('client recovery timeout abandons the server session before reporting failure', () => {
  const timers = createFakeTimers();
  const socket = new FakeSocket();
  const manager = new SocketManager({
    recoveryTimeoutMs: 500,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });
  manager.socket = socket;
  manager.recovery.establish({ recoveryToken: 'c'.repeat(64), code: '1234', role: 'initiator' });
  manager.recovery.markRecovering();

  timers.runNext();
  assert.deepEqual(socket.sent[0], {
    event: 'abandon-recovery',
    payload: { recoveryToken: 'c'.repeat(64) }
  });
  assert.equal(manager.recovery.state, 'recovery-failed');
  assert.equal(manager.recovery.session, null);
});

test('manual pairing sends abandonment before opening a new join attempt', () => {
  const socket = new FakeSocket();
  const manager = new SocketManager();
  manager.socket = socket;
  manager.recovery.establish({ recoveryToken: 'd'.repeat(64), code: '1234', role: 'receiver' });
  manager.recovery.markRecovering();

  manager.joinCode('2468');
  assert.deepEqual(socket.sent, [
    { event: 'abandon-recovery', payload: { recoveryToken: 'd'.repeat(64) } },
    { event: 'join-code', payload: { code: '2468' } }
  ]);
  assert.equal(manager.recovery.state, 'unpaired');
});

test('manual pairing clears delivered and pending client token state', () => {
  const socket = new FakeSocket();
  const manager = new SocketManager();
  manager.socket = socket;
  manager.connectionGeneration = 1;
  manager.recoveryRequestGeneration = 1;
  manager.recovery.establish({ recoveryToken: 'a'.repeat(64), code: '1234', role: 'initiator' });
  manager.recovery.markRecovering();
  manager.storeRecoveryTokenAndAcknowledge('b'.repeat(64), socket, 1);
  const acknowledgements = socket.sent.filter((entry) => entry.event === 'recovery-token-ack').length;

  manager.joinCode('2468');
  assert.equal(manager.recovery.session, null);
  assert.equal(manager.pendingAbandonSession, null);
  assert.equal(manager.storeRecoveryTokenAndAcknowledge('c'.repeat(64), socket, 1), false);
  assert.equal(
    socket.sent.filter((entry) => entry.event === 'recovery-token-ack').length,
    acknowledgements
  );
});

test('a late recovered event cannot overwrite a new manual pairing attempt', () => {
  const socket = new FakeSocket();
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => socket;
  try {
    const manager = new SocketManager();
    let recoveredEvents = 0;
    manager.onPaired = ({ recovered }) => { if (recovered) recoveredEvents += 1; };
    manager.connect();
    socket.receive('connect');
    socket.receive('paired', {
      role: 'initiator', code: '1234', recoveryToken: 'e'.repeat(64), recovered: false
    });
    socket.receive('peer-disconnected', { recoverable: true });
    manager.joinCode('2468');
    socket.receive('paired', {
      role: 'initiator', code: '1234', recoveryToken: 'f'.repeat(64), recovered: true
    });

    assert.equal(recoveredEvents, 0);
    assert.equal(manager.recovery.state, 'unpaired');
    assert.deepEqual(socket.sent.at(-1), { event: 'join-code', payload: { code: '2468' } });
  } finally {
    global.window = previousWindow;
    global.io = previousIo;
  }
});

test('multiple connect events send only one recovery request per logical connection', () => {
  const socket = new FakeSocket();
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => socket;
  try {
    const manager = new SocketManager();
    manager.connect();
    socket.receive('connect');
    socket.receive('paired', {
      role: 'receiver', code: '1234', recoveryToken: '1'.repeat(64), recovered: false
    });
    socket.receive('disconnect', 'transport close');
    socket.receive('connect');
    socket.receive('connect');

    assert.equal(socket.sent.filter((entry) => entry.event === 'recover-session').length, 1);
  } finally {
    global.window = previousWindow;
    global.io = previousIo;
  }
});

test('duplicate recovered events initialize replacement signaling only once', () => {
  const socket = new FakeSocket();
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => socket;
  try {
    const manager = new SocketManager();
    let recoveredEvents = 0;
    manager.onPaired = ({ recovered }) => { if (recovered) recoveredEvents += 1; };
    manager.connect();
    socket.receive('connect');
    socket.receive('paired', {
      role: 'initiator', code: '1234', recoveryToken: '2'.repeat(64), recovered: false
    });
    socket.receive('peer-disconnected', { recoverable: true });
    const recovered = {
      role: 'initiator', code: '1234', recoveryToken: '3'.repeat(64), recovered: true
    };
    socket.receive('paired', recovered);
    socket.receive('paired', recovered);

    assert.equal(recoveredEvents, 1);
    assert.equal(manager.recovery.state, 'recovering');
  } finally {
    global.window = previousWindow;
    global.io = previousIo;
  }
});

test('a second peer recovery on the same Socket.IO connection is accepted once', () => {
  const socket = new FakeSocket();
  const previousWindow = global.window;
  const previousIo = global.io;
  global.window = { AirDowsRuntime: {} };
  global.io = () => socket;
  try {
    const manager = new SocketManager();
    let recoveredEvents = 0;
    manager.onPaired = ({ recovered }) => { if (recovered) recoveredEvents += 1; };
    manager.connect();
    socket.receive('connect');
    socket.receive('paired', {
      role: 'receiver', code: '1234', recoveryToken: '6'.repeat(64), recovered: false
    });

    socket.receive('peer-disconnected', { recoverable: true });
    socket.receive('paired', {
      role: 'receiver', code: '1234', recoveryToken: '7'.repeat(64), recovered: true
    });
    assert.equal(manager.completeRecovery(), true);

    socket.receive('peer-disconnected', { recoverable: true });
    socket.receive('paired', {
      role: 'receiver', code: '1234', recoveryToken: '8'.repeat(64), recovered: true
    });
    socket.receive('paired', {
      role: 'receiver', code: '1234', recoveryToken: '8'.repeat(64), recovered: true
    });

    assert.equal(recoveredEvents, 2);
    assert.equal(manager.recovery.state, 'recovering');
  } finally {
    global.window = previousWindow;
    global.io = previousIo;
  }
});

test('recovery success and failure settle once and only after data-channel confirmation', () => {
  const recovery = new SessionRecoveryState();
  const session = { recoveryToken: '4'.repeat(64), code: '1234', role: 'initiator' };
  recovery.establish(session);
  recovery.markRecovering();
  recovery.updateRecoveryCredential({ ...session, recoveryToken: '5'.repeat(64) });
  assert.equal(recovery.state, 'recovering');
  assert.equal(recovery.completeRecovery(), true);
  assert.equal(recovery.fail(), false);
  assert.equal(recovery.state, 'recovered');

  recovery.reset();
  recovery.establish(session);
  recovery.markRecovering();
  assert.equal(recovery.fail(), true);
  assert.equal(recovery.completeRecovery(), false);
  assert.equal(recovery.state, 'recovery-failed');
});

test('a rotated credential can still abandon its bound recovered socket at the timeout boundary', () => {
  const { security, initiator } = createPairedRoom();
  const oldToken = initiator.recoveryToken;
  security.markSocketDisconnected('socket-initiator');
  const recovered = security.recoverSession(oldToken, 'initiator-new');

  assert.equal(security.abandonRecovery(oldToken, 'initiator-new', 200).ok, true);
  assert.equal(security.activeRooms.has('1234'), false);
  assert.equal(security.recoveryTokens.has(recovered.recoveryToken), false);
  assert.equal(security.invalidatedCodes.get('1234'), 200);
});

test('pre-recovery ACK waiter is rejected and cannot complete the recovered transfer', async () => {
  const manager = createRtcManager();
  const oldChannel = new FakeDataChannel();
  manager.role = 'initiator';
  manager.roomCode = '1234';
  manager.setDataChannel(oldChannel);
  manager.activeSendTransfer = {
    transferId: 'same-transfer', terminalState: null, terminalCallbackInvoked: false, reader: null
  };
  const waiter = manager.createDeliveryWaiter('same-transfer', 10);
  manager.prepareForRecovery();

  await assert.rejects(waiter, (error) => error.code === 'DATA_CHANNEL_REPLACED');
  assert.equal(manager.deliveryWaiters.size, 0);
  assert.equal(manager.handleTransferAck({ type: 'transfer-ack', transferId: 'same-transfer', size: 10 }), false);
});

test('an obsolete sender attempt cannot write through a replacement DataChannel', () => {
  const manager = createRtcManager();
  manager.setDataChannel(new FakeDataChannel());
  const transfer = {
    cancelled: false,
    channelGeneration: manager.dataChannelGeneration
  };
  manager.prepareForRecovery();
  const replacement = new FakeDataChannel();
  manager.setDataChannel(replacement);

  assert.throws(
    () => manager.throwIfTransferCancelled(transfer),
    (error) => error.code === 'DATA_CHANNEL_REPLACED'
  );
  assert.equal(replacement.sent.length, 0);
});

test('old DataChannel events are ignored after recovery preparation', async () => {
  const manager = createRtcManager();
  const oldChannel = new FakeDataChannel();
  manager.setDataChannel(oldChannel);
  let handled = 0;
  manager.handleIncomingMessage = async () => { handled += 1; };
  manager.prepareForRecovery();
  oldChannel.onmessage?.({ data: JSON.stringify({ type: 'clipboard', text: 'stale' }) });
  await Promise.resolve();
  assert.equal(handled, 0);
});

test('delayed signaling work from an obsolete peer connection cannot mutate recovery', async () => {
  let releaseRemoteDescription;
  let answersCreated = 0;
  const signals = [];
  const manager = new WebRTCManager({
    sendSignal: (...args) => signals.push(args)
  });
  manager.role = 'receiver';
  manager.roomCode = '1234';
  manager.rtcConfig = { iceServers: [] };
  const oldPeer = {
    remoteDescription: null,
    setRemoteDescription: () => new Promise((resolve) => { releaseRemoteDescription = resolve; }),
    createAnswer: async () => { answersCreated += 1; return { type: 'answer' }; },
    setLocalDescription: async () => {},
    close() {}
  };
  manager.peerConnection = oldPeer;
  manager.peerConnectionGeneration = 1;
  const previousDescription = global.RTCSessionDescription;
  global.RTCSessionDescription = function FakeRTCSessionDescription(description) {
    return description;
  };
  try {
    const handling = manager.handleSignal({ type: 'offer', offer: { type: 'offer' } });
    manager.prepareForRecovery();
    manager.peerConnection = { close() {} };
    releaseRemoteDescription();
    await handling;
    assert.equal(answersCreated, 0);
    assert.equal(signals.length, 0);
  } finally {
    global.RTCSessionDescription = previousDescription;
  }
});

test('partial receiver state is preserved for transferId-isolated resume', () => {
  const manager = createRtcManager();
  const state = manager.receiverState;
  state.metadata = { transferId: 'resume-transfer', name: 'same.bin', size: 100 };
  state.receivedSize = 40;
  manager.setDataChannel(new FakeDataChannel());
  manager.prepareForRecovery();

  assert.equal(manager.receiverState, state);
  assert.equal(manager.receiverState.receivedSize, 40);
  assert.equal(manager.receiverState.metadata.transferId, 'resume-transfer');
});

test('completed receipts and partial state are scoped to one pairing session', () => {
  const manager = createRtcManager();
  manager.sessionGeneration = 7;
  manager.receiverState = manager.createEmptyReceiverState();
  manager.receiverState.metadata = {
    transferId: 'shared-transfer', name: 'same.bin', size: 10
  };
  manager.receiverState.receivedSize = 4;
  manager.rememberCompletedTransfer(
    { transferId: 'completed-transfer', name: 'done.bin', size: 1 },
    'memory',
    1
  );

  manager.startNewPairingSession();
  assert.equal(manager.sessionGeneration, 8);
  assert.equal(manager.completedTransfers.size, 0);
  assert.equal(manager.completedTransferIds.size, 0);
  assert.equal(manager.receiverState.metadata, null);
  assert.equal(manager.receiverState.receivedSize, 0);
  assert.equal(manager.receiverState.sessionGeneration, 8);
});

test('the same transferId and size in a new pairing session cannot use an old receipt', async () => {
  const manager = createRtcManager();
  manager.startNetworkDiagnostics = () => {};
  manager.setDataChannel(new FakeDataChannel());
  manager.rememberCompletedTransfer(
    { transferId: 'same-id', name: 'same.bin', size: 0 },
    'memory',
    manager.dataChannelGeneration
  );
  manager.startNewPairingSession();
  const channel = new FakeDataChannel();
  manager.setDataChannel(channel);

  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'metadata', transferId: 'same-id', name: 'same.bin', size: 0,
    mime: 'application/octet-stream', encryption: null
  }));

  assert.equal(manager.receiverState.metadata.transferId, 'same-id');
  const ready = channel.sent.map((value) => JSON.parse(value)).find((value) => value.type === 'receiver-ready');
  assert.equal(ready.offset, 0);
  assert.equal(manager.completedTransfers.size, 0);
});

test('completed receipt cache eviction retains duplicate-finalization protection', async () => {
  const manager = createRtcManager();
  for (let index = 0; index < manager.MAX_COMPLETED_TRANSFER_RECEIPTS + 1; index += 1) {
    manager.rememberCompletedTransfer(
      { transferId: `receipt-${index}`, name: 'same.bin', size: index },
      'memory',
      1
    );
  }

  assert.equal(manager.completedTransfers.size, manager.MAX_COMPLETED_TRANSFER_RECEIPTS);
  assert.equal(manager.completedTransfers.has('receipt-0'), false);
  assert.equal(manager.completedTransfers.has('receipt-1'), true);
  assert.equal(manager.completedTransfers.has('receipt-128'), true);
  assert.equal(manager.completedTransferIds.has('receipt-0'), true);

  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };
  manager.setDataChannel(new FakeDataChannel());
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'metadata', transferId: 'receipt-0', name: 'same.bin', size: 0,
    mime: 'application/octet-stream', encryption: null
  }));
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-finished', transferId: 'receipt-0', size: 0
  }));
  assert.equal(manager.receiverState.metadata, null);
  assert.equal(completions, 0);
});

test('close clears completed receipts and retained partial receiver state', () => {
  const manager = createRtcManager();
  manager.rememberCompletedTransfer(
    { transferId: 'done', name: 'done.bin', size: 1 },
    'memory',
    1
  );
  manager.receiverState.metadata = { transferId: 'partial', name: 'part.bin', size: 5 };
  manager.receiverState.receivedSize = 2;

  manager.close();
  assert.equal(manager.completedTransfers.size, 0);
  assert.equal(manager.completedTransferIds.size, 0);
  assert.equal(manager.receiverState.metadata, null);
  assert.equal(manager.receiverState.receivedSize, 0);
});

test('a finalized receiver transfer is ACKed after recovery without duplicate completion', async () => {
  const manager = createRtcManager();
  const firstChannel = new FakeDataChannel();
  manager.setDataChannel(firstChannel);
  manager.receiverState.metadata = {
    type: 'metadata', transferId: 'receipt-transfer', name: 'saved.bin', size: 1,
    mime: 'application/octet-stream', encryption: null
  };
  manager.receiverState.receivedBuffers = [new Uint8Array([7])];
  manager.receiverState.receivedSize = 1;
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };

  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-finished', transferId: 'receipt-transfer', size: 1
  }));
  assert.equal(completions, 1);

  manager.prepareForRecovery();
  const recoveredChannel = new FakeDataChannel();
  manager.setDataChannel(recoveredChannel);
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'metadata', transferId: 'receipt-transfer', name: 'saved.bin', size: 1,
    mime: 'application/octet-stream', encryption: null
  }));
  await manager.handleIncomingTextMessage(JSON.stringify({
    type: 'transfer-finished', transferId: 'receipt-transfer', size: 1
  }));

  const controls = recoveredChannel.sent.map((raw) => JSON.parse(raw));
  assert.equal(controls.find((message) => message.type === 'receiver-ready').offset, 1);
  assert.equal(controls.filter((message) => message.type === 'transfer-ack').length, 1);
  assert.equal(completions, 1);
});

test('sequential transfers complete normally after a recovered DataChannel opens', async () => {
  const manager = createRtcManager();
  manager.role = 'initiator';
  manager.roomCode = '1234';
  manager.selectPerformanceProfile = async () => ({
    chunkSize: 4, bufferThreshold: 1024, lowThreshold: 1,
    label: 'test', connectionType: 'host'
  });
  manager.waitForEncryption = async () => null;
  manager.startNetworkDiagnostics = () => {};
  manager.stopNetworkDiagnostics = () => {};
  manager.reportTransferProgress = () => {};

  const channel = new FakeDataChannel((raw) => {
    if (typeof raw !== 'string') return;
    const message = JSON.parse(raw);
    if (message.type === 'metadata') {
      setTimeout(() => manager.handleIncomingTextMessage(JSON.stringify({
        type: 'receiver-ready', transferId: message.transferId, offset: 0, size: message.size
      })), 0);
    }
    if (message.type === 'transfer-finished') {
      setTimeout(() => manager.handleIncomingTextMessage(JSON.stringify({
        type: 'transfer-ack', transferId: message.transferId, size: message.size
      })), 0);
    }
  });
  manager.setDataChannel(new FakeDataChannel());
  manager.prepareForRecovery();
  manager.setDataChannel(channel);
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };

  await manager.sendFile(new File([], 'same.bin'), { transferId: 'transfer-a' });
  await manager.sendFile(new File([], 'same.bin'), { transferId: 'transfer-b' });
  assert.equal(completions, 2);
  assert.equal(manager.deliveryWaiters.size, 0);
});

test('repeated recovery cycles retry one outgoing transfer sequentially with the same transferId', async () => {
  const manager = createRtcManager();
  manager.role = 'initiator';
  manager.roomCode = '1234';
  manager.selectPerformanceProfile = async () => ({
    chunkSize: 4, bufferThreshold: 1024, lowThreshold: 1,
    label: 'test', connectionType: 'host'
  });
  manager.waitForEncryption = async () => null;
  manager.startNetworkDiagnostics = () => {};
  manager.stopNetworkDiagnostics = () => {};
  manager.reportTransferProgress = () => {};

  const transferId = 'stable-retry-id';
  const metadataIds = [];
  let attempt = 0;
  let completions = 0;
  manager.onFileTransferComplete = () => { completions += 1; };

  const installAttemptChannel = (shouldFail) => {
    const channel = new FakeDataChannel((raw) => {
      if (typeof raw !== 'string') return;
      const message = JSON.parse(raw);
      if (message.type === 'metadata') {
        metadataIds.push(message.transferId);
        setTimeout(() => manager.handleIncomingTextMessage(JSON.stringify({
          type: 'receiver-ready', transferId: message.transferId, offset: 0, size: message.size
        })), 0);
      }
      if (message.type === 'transfer-finished') {
        if (shouldFail) {
          setTimeout(() => manager.prepareForRecovery(), 0);
        } else {
          setTimeout(() => manager.handleIncomingTextMessage(JSON.stringify({
            type: 'transfer-ack', transferId: message.transferId, size: message.size
          })), 0);
        }
      }
    });
    manager.setDataChannel(channel);
  };

  for (const shouldFail of [true, true, false]) {
    attempt += 1;
    manager.recoveryPrepared = false;
    installAttemptChannel(shouldFail);
    const sending = manager.sendFile(new File([], 'same.bin'), { transferId });
    if (shouldFail) {
      await assert.rejects(sending, (error) => error.code === 'DATA_CHANNEL_REPLACED');
    } else {
      await sending;
    }
    assert.equal(manager.activeSendTransfer, null);
  }

  assert.equal(attempt, 3);
  assert.deepEqual(metadataIds, [transferId, transferId, transferId]);
  assert.equal(completions, 1);
  assert.equal(manager.deliveryWaiters.size, 0);
  assert.equal(manager.resumeWaiters.size, 0);
});

test('application recovery preserves pending work and prevents false completion/history duplication', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(source, /beginSessionRecovery[\s\S]*activeQueueItem\.status = 'pending'/);
  assert.match(source, /if \(!recovered\) \{[\s\S]*if \(!preserveQueueAfterRecoveryFailure\) transferQueue = \[\]/);
  assert.match(source, /if \(recovered\) \{[\s\S]*webrtcManager\.reconnect\(role, code\)/);
  assert.doesNotMatch(source, /if \(recovered\)[\s\S]{0,300}appendHistoryItem/);
  assert.match(source, /await webrtcManager\.sendFile[\s\S]*nextItem\.status = 'done'/);
  assert.match(source, /if \(recoveryCompleted\) socketManager\.completeRecovery\(\)/);
  assert.match(source, /resetApp\(\{ preserveQueue: preserveQueueAfterRecoveryFailure \}\)/);
});

test('server recovery remains bounded, token-based, and opaque', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(source, /SESSION_RECOVERY_GRACE_MS = 60 \* 1000/);
  assert.match(source, /socket\.on\('recover-session'/);
  assert.match(source, /recoveryToken/);
  assert.match(source, /recovery-failed', \{ message: 'CONNECT_FAILED' \}/);
  assert.match(source, /socket\.on\('abandon-recovery'/);
  assert.match(source, /activeRoom\.state !== 'paired'/);
  assert.match(source, /pairingSecurity\.socketRooms\.get\(socket\.id\) !== room/);
  assert.doesNotMatch(source, /\[Recovery\][^\n]*(recoveryToken|code|socket\.id)/);
});

test('PairingLinkPrivacy behavior and fragment-only link generation remain unchanged', () => {
  const privacy = require('../public/js/pairing-link-privacy');
  const result = privacy.sanitizePairingUrl('https://airdows.com/app#code=1234');
  assert.equal(result.code, '1234');
  assert.equal(result.sanitizedUrl, 'https://airdows.com/app');
  assert.equal(privacy.buildPairingLink('https://airdows.com', '1234'), 'https://airdows.com/app#code=1234');
});
