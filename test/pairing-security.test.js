'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONNECT_FAILED,
  getHttpRateLimitKey,
  getIpRateLimitKey,
  IpRateLimiter,
  normalizeClientIp,
  resolveClientIp,
  PairingSecurity
} = require('../pairing-security');

const IPV6_SUBNET_A_FIRST = '2001:db8:abcd:1200::1';
const IPV6_SUBNET_A_SECOND = '2001:db8:abcd:12ff::2';
const IPV6_SUBNET_B = '2001:db8:abcd:1300::1';

function createHttpRequest({ xForwardedFor, xRealIp, remoteAddress }) {
  return {
    headers: {
      'x-forwarded-for': xForwardedFor,
      'x-real-ip': xRealIp
    },
    socket: { remoteAddress }
  };
}

test('local HTTP limiter identity ignores spoofed X-Forwarded-For', () => {
  const key = getHttpRateLimitKey(createHttpRequest({
    xForwardedFor: '203.0.113.210',
    remoteAddress: '192.0.2.30'
  }));

  assert.equal(key, '192.0.2.30');
});

test('local HTTP limiter identity ignores spoofed X-Real-IP', () => {
  const key = getHttpRateLimitKey(createHttpRequest({
    xRealIp: '203.0.113.211',
    remoteAddress: '192.0.2.31'
  }));

  assert.equal(key, '192.0.2.31');
});

test('Railway HTTP limiter identity uses a valid X-Real-IP', () => {
  const key = getHttpRateLimitKey(createHttpRequest({
    xRealIp: '198.51.100.30',
    remoteAddress: '10.0.0.30'
  }), 'production');

  assert.equal(key, '198.51.100.30');
});

test('Railway HTTP limiter identity ignores X-Forwarded-For', () => {
  const key = getHttpRateLimitKey(createHttpRequest({
    xForwardedFor: '203.0.113.212',
    remoteAddress: '10.0.0.31'
  }), 'production');

  assert.equal(key, '10.0.0.31');
});

test('spoofed X-Forwarded-For rotation cannot create new HTTP limiter buckets', () => {
  const firstKey = getHttpRateLimitKey(createHttpRequest({
    xForwardedFor: '203.0.113.213',
    remoteAddress: '192.0.2.32'
  }));
  const secondKey = getHttpRateLimitKey(createHttpRequest({
    xForwardedFor: '203.0.113.214',
    remoteAddress: '192.0.2.32'
  }));

  assert.equal(firstKey, secondKey);
});

test('different valid Railway X-Real-IP addresses have independent HTTP limiter keys', () => {
  const firstKey = getHttpRateLimitKey(createHttpRequest({
    xRealIp: '198.51.100.31',
    remoteAddress: '10.0.0.32'
  }), 'production');
  const secondKey = getHttpRateLimitKey(createHttpRequest({
    xRealIp: '198.51.100.32',
    remoteAddress: '10.0.0.32'
  }), 'production');

  assert.notEqual(firstKey, secondKey);
});

test('invalid Railway X-Real-IP falls back to the direct HTTP socket address', () => {
  const key = getHttpRateLimitKey(createHttpRequest({
    xRealIp: '198.51.100.33, 198.51.100.34',
    remoteAddress: '::ffff:192.0.2.33'
  }), 'production');

  assert.equal(key, '192.0.2.33');
});

test('IPv6 addresses in the same /56 share the HTTP limiter key', () => {
  const firstKey = getHttpRateLimitKey(createHttpRequest({
    xRealIp: IPV6_SUBNET_A_FIRST,
    remoteAddress: '10.0.0.40'
  }), 'production');
  const secondKey = getHttpRateLimitKey(createHttpRequest({
    xRealIp: IPV6_SUBNET_A_SECOND,
    remoteAddress: '10.0.0.40'
  }), 'production');

  assert.equal(firstKey, secondKey);
});

test('IPv6 addresses in the same /56 share the Socket.IO connection limit', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

  assert.equal(limiter.attempt(IPV6_SUBNET_A_FIRST, 0).allowed, true);
  assert.equal(limiter.attempt(IPV6_SUBNET_A_SECOND, 0).allowed, false);
  assert.equal(limiter.entries.size, 1);
});

test('IPv6 addresses in the same /56 share the generation limit', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

  assert.equal(limiter.attempt(IPV6_SUBNET_A_FIRST, 0).allowed, true);
  assert.equal(limiter.attempt(IPV6_SUBNET_A_SECOND, 0).allowed, false);
  assert.equal(limiter.entries.size, 1);
});

test('IPv6 addresses in the same /56 share the join limit', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

  assert.equal(limiter.attempt(IPV6_SUBNET_A_FIRST, 0).allowed, true);
  assert.equal(limiter.attempt(IPV6_SUBNET_A_SECOND, 0).allowed, false);
  assert.equal(limiter.entries.size, 1);
});

test('IPv6 addresses in different /56 subnets have independent limiter keys', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

  assert.notEqual(getIpRateLimitKey(IPV6_SUBNET_A_FIRST), getIpRateLimitKey(IPV6_SUBNET_B));
  assert.equal(limiter.attempt(IPV6_SUBNET_A_FIRST, 0).allowed, true);
  assert.equal(limiter.attempt(IPV6_SUBNET_B, 0).allowed, true);
  assert.equal(limiter.entries.size, 2);
});

test('local development ignores a spoofed X-Forwarded-For header', () => {
  const clientIp = resolveClientIp({
    xForwardedFor: '203.0.113.200',
    remoteAddress: '192.0.2.10',
    handshakeAddress: '192.0.2.11'
  });

  assert.equal(clientIp, '192.0.2.10');
});

test('local development ignores a spoofed X-Real-IP header', () => {
  const clientIp = resolveClientIp({
    xRealIp: '203.0.113.201',
    remoteAddress: '192.0.2.12',
    handshakeAddress: '192.0.2.13'
  });

  assert.equal(clientIp, '192.0.2.12');
});

test('Railway uses a single valid IPv4 or IPv6 X-Real-IP value', () => {
  assert.equal(resolveClientIp({
    railwayEnvironmentId: 'production',
    xRealIp: '198.51.100.20',
    remoteAddress: '10.0.0.2'
  }), '198.51.100.20');

  assert.equal(resolveClientIp({
    railwayEnvironmentId: 'production',
    xRealIp: '2001:DB8::20',
    remoteAddress: '10.0.0.2'
  }), '2001:db8::20');
});

test('Railway ignores X-Forwarded-For even when X-Real-IP is missing', () => {
  const clientIp = resolveClientIp({
    railwayEnvironmentId: 'production',
    xForwardedFor: '203.0.113.202',
    remoteAddress: '10.0.0.3',
    handshakeAddress: '10.0.0.4'
  });

  assert.equal(clientIp, '10.0.0.3');
});

test('Railway falls back to the direct address when X-Real-IP is invalid', () => {
  const clientIp = resolveClientIp({
    railwayEnvironmentId: 'production',
    xRealIp: '198.51.100.21, 198.51.100.22',
    remoteAddress: '::ffff:192.0.2.14',
    handshakeAddress: '192.0.2.15'
  });

  assert.equal(clientIp, '192.0.2.14');
});

test('different spoofed X-Forwarded-For values share the connection limit', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  const firstIp = resolveClientIp({
    xForwardedFor: '203.0.113.203',
    remoteAddress: '192.0.2.16'
  });
  const secondIp = resolveClientIp({
    xForwardedFor: '203.0.113.204',
    remoteAddress: '192.0.2.16'
  });

  assert.equal(limiter.attempt(firstIp, 0).allowed, true);
  assert.equal(limiter.attempt(secondIp, 0).allowed, false);
  assert.equal(limiter.entries.size, 1);
});

test('spoofed X-Forwarded-For rotation cannot bypass generation limits', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  const directAddress = '192.0.2.17';

  assert.equal(limiter.attempt(resolveClientIp({
    xForwardedFor: '203.0.113.205',
    remoteAddress: directAddress
  }), 0).allowed, true);
  assert.equal(limiter.attempt(resolveClientIp({
    xForwardedFor: '203.0.113.206',
    remoteAddress: directAddress
  }), 0).allowed, false);
});

test('spoofed X-Forwarded-For rotation cannot bypass join limits', () => {
  const limiter = new IpRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  const directAddress = '192.0.2.18';

  assert.equal(limiter.attempt(resolveClientIp({
    xForwardedFor: '203.0.113.207',
    remoteAddress: directAddress
  }), 0).allowed, true);
  assert.equal(limiter.attempt(resolveClientIp({
    xForwardedFor: '203.0.113.208',
    remoteAddress: directAddress
  }), 0).allowed, false);
});

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
  assert.equal(getIpRateLimitKey('::ffff:192.0.2.1'), getIpRateLimitKey('192.0.2.1'));
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
