'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONNECT_FAILED,
  IpRateLimiter,
  normalizeClientIp,
  PairingSecurity
} = require('../pairing-security');

test('expired invalidated codes are pruned and can become available again', () => {
  const ttl = 10 * 60 * 1000;
  const security = new PairingSecurity({
    invalidatedCodeTtlMs: ttl,
    randomInt: () => 1234
  });

  security.invalidateCode('1234', 0);
  assert.equal(security.invalidatedCodes.has('1234'), true);

  assert.equal(security.generateUniqueCode(ttl), '1234');
  assert.equal(security.invalidatedCodes.has('1234'), false);
});

test('joining a nonexistent code does not invalidate it', () => {
  const security = new PairingSecurity();

  const result = security.attemptJoin('4321', 'socket-a');

  assert.deepEqual(result, { ok: false, error: { message: CONNECT_FAILED } });
  assert.equal(security.invalidatedCodes.has('4321'), false);
});

test('a paired room cannot accept a third participant', () => {
  const security = new PairingSecurity();
  security.createRoom('1234', 'socket-a', null);

  assert.equal(security.attemptJoin('1234', 'socket-b').ok, true);
  assert.equal(security.activeRooms.get('1234').state, 'paired');

  const thirdJoin = security.attemptJoin('1234', 'socket-c');
  assert.deepEqual(thirdJoin, { ok: false, error: { message: CONNECT_FAILED } });
  assert.deepEqual(
    Array.from(security.activeRooms.get('1234').occupants),
    ['socket-a', 'socket-b']
  );
});

test('a paired room is destroyed and invalidated when either participant leaves', () => {
  const security = new PairingSecurity();
  security.createRoom('1234', 'socket-a', null);
  security.attemptJoin('1234', 'socket-b');

  const endedRooms = security.endRoomsForSocket('socket-a', 100);

  assert.equal(endedRooms.length, 1);
  assert.equal(endedRooms[0].state, 'paired');
  assert.equal(security.activeRooms.has('1234'), false);
  assert.equal(security.invalidatedCodes.get('1234'), 100);
});

test('generation attempt 10 is allowed and attempt 11 is blocked', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 10, windowMs: 60_000 });

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    assert.equal(limiter.attempt('203.0.113.8', 0).allowed, true);
  }

  assert.equal(limiter.attempt('203.0.113.8', 0).allowed, false);
});

test('join attempt 30 is allowed and attempt 31 is blocked', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 30, windowMs: 60_000 });

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    assert.equal(limiter.attempt('203.0.113.9', 0).allowed, true);
  }

  assert.equal(limiter.attempt('203.0.113.9', 0).allowed, false);
});

test('socket connection attempt 60 is allowed and attempt 61 is blocked', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 60, windowMs: 60_000 });

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    assert.equal(limiter.attempt('203.0.113.10', 0).allowed, true);
  }

  assert.equal(limiter.attempt('203.0.113.10', 0).allowed, false);
});

test('generation, join, and connection limiters reset after 60 seconds', () => {
  for (const maxAttempts of [10, 30, 60]) {
    const limiter = new IpRateLimiter({ maxAttempts, windowMs: 60_000 });

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      limiter.attempt('203.0.113.11', 0);
    }

    assert.equal(limiter.attempt('203.0.113.11', 59_999).allowed, false);
    assert.equal(limiter.attempt('203.0.113.11', 60_000).allowed, true);
  }
});

test('expired rate-limit entries are removed by periodic cleanup', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  limiter.attempt('203.0.113.16', 0);

  limiter.prune(60_000);

  assert.equal(limiter.entries.size, 0);
  assert.equal(limiter.attempt('203.0.113.16', 60_000).allowed, true);
});

test('different IP addresses have independent limits', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

  assert.equal(limiter.attempt('203.0.113.12', 0).allowed, true);
  assert.equal(limiter.attempt('203.0.113.12', 0).allowed, false);
  assert.equal(limiter.attempt('203.0.113.13', 0).allowed, true);
});

test('IPv4 and IPv4-mapped IPv6 representations share the same limit', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

  assert.equal(normalizeClientIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(limiter.attempt('::ffff:192.0.2.1', 0).allowed, true);
  assert.equal(limiter.attempt('192.0.2.1', 0).allowed, false);
  assert.equal(limiter.entries.size, 1);
});

test('new sockets and different target codes share one IP-wide join limit', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 30, windowMs: 60_000 });
  const clientIp = '203.0.113.14';

  for (let targetCode = 1000; targetCode < 1030; targetCode += 1) {
    assert.equal(limiter.attempt(clientIp, 0).allowed, true);
  }

  assert.equal(limiter.attempt(clientIp, 0).allowed, false);
  assert.equal(limiter.entries.size, 1);
});

test('new sockets from the same IP share the global code-generation limit', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 10, windowMs: 60_000 });

  for (let socketNumber = 0; socketNumber < 10; socketNumber += 1) {
    assert.equal(limiter.attempt('203.0.113.15', 0).allowed, true);
  }

  assert.equal(limiter.attempt('203.0.113.15', 0).allowed, false);
});

test('invalid, expired, used, and full codes return the same opaque error', () => {
  const security = new PairingSecurity();
  const expectedError = { message: CONNECT_FAILED };

  const invalid = security.attemptJoin('not-a-code', 'socket-z').error;

  security.createRoom('1111', 'socket-a', null);
  security.destroyRoom('1111', 0);
  const expired = security.attemptJoin('1111', 'socket-z').error;

  security.createRoom('2222', 'socket-a', null);
  security.attemptJoin('2222', 'socket-b');
  const full = security.attemptJoin('2222', 'socket-c').error;

  security.createRoom('3333', 'socket-a', null);
  security.attemptJoin('3333', 'socket-b');
  security.destroyRoom('3333', 0);
  const used = security.attemptJoin('3333', 'socket-c').error;

  assert.deepEqual(invalid, expectedError);
  assert.deepEqual(expired, expectedError);
  assert.deepEqual(used, expectedError);
  assert.deepEqual(full, expectedError);
});

test('a waiting room is destroyed and invalidated when its creator leaves', () => {
  const security = new PairingSecurity();
  security.createRoom('4444', 'socket-a', null);

  const endedRooms = security.endRoomsForSocket('socket-a', 200);

  assert.equal(endedRooms.length, 1);
  assert.equal(endedRooms[0].state, 'waiting');
  assert.equal(security.activeRooms.has('4444'), false);
  assert.equal(security.invalidatedCodes.get('4444'), 200);
  assert.equal(security.socketRooms.has('socket-a'), false);
});

test('an unused room timeout destroys and invalidates the room', () => {
  const security = new PairingSecurity();
  const room = security.createRoom('5555', 'socket-a', null);

  assert.equal(security.expireRoom('5555', room, 300), room);
  assert.equal(security.activeRooms.has('5555'), false);
  assert.equal(security.invalidatedCodes.get('5555'), 300);
  assert.equal(security.socketRooms.has('socket-a'), false);
});

test('ending or destroying the same room twice is idempotent', () => {
  const security = new PairingSecurity();
  security.createRoom('6666', 'socket-a', null);

  assert.equal(security.endRoomsForSocket('socket-a', 400).length, 1);
  assert.deepEqual(security.endRoomsForSocket('socket-a', 401), []);
  assert.equal(security.destroyRoom('6666', 402), null);
  assert.equal(security.invalidatedCodes.get('6666'), 400);
});

test('destroying a paired room removes both occupants from socket-to-room tracking', () => {
  const security = new PairingSecurity();
  security.createRoom('7777', 'socket-a', null);
  security.attemptJoin('7777', 'socket-b');

  security.destroyRoom('7777', 500);

  assert.equal(security.socketRooms.has('socket-a'), false);
  assert.equal(security.socketRooms.has('socket-b'), false);
  assert.equal(security.activeRooms.has('7777'), false);
});

test('a stale timeout cannot destroy a newer room that reused the same code', () => {
  const ttl = 10 * 60 * 1000;
  const security = new PairingSecurity({ invalidatedCodeTtlMs: ttl });
  const oldRoom = security.createRoom('8888', 'socket-old', null);
  security.destroyRoom('8888', 0);
  security.pruneInvalidatedCodes(ttl);
  const newRoom = security.createRoom('8888', 'socket-new', null);

  assert.equal(security.expireRoom('8888', oldRoom, ttl + 1), null);
  assert.equal(security.activeRooms.get('8888'), newRoom);
  assert.equal(security.socketRooms.get('socket-new'), '8888');
});
