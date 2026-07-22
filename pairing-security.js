'use strict';

const crypto = require('crypto');
const net = require('net');
const { ipKeyGenerator } = require('express-rate-limit');

const CONNECT_FAILED = 'CONNECT_FAILED';
const DEFAULT_INVALIDATED_CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

function normalizeClientIp(clientIp) {
  const normalized = String(clientIp || 'unknown').trim().toLowerCase();
  const mappedIpv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : '';
  return net.isIP(mappedIpv4) === 4 ? mappedIpv4 : normalized;
}

function getIpRateLimitKey(clientIp) {
  return ipKeyGenerator(normalizeClientIp(clientIp));
}

function getSingleValidIp(headerValue) {
  if (Array.isArray(headerValue)) {
    if (headerValue.length !== 1) return null;
    [headerValue] = headerValue;
  }
  if (typeof headerValue !== 'string') return null;

  const candidate = headerValue.trim();
  if (!candidate || candidate.includes(',') || net.isIP(candidate) === 0) return null;
  return normalizeClientIp(candidate);
}

function resolveClientIp({
  railwayEnvironmentId,
  xRealIp,
  remoteAddress,
  handshakeAddress
} = {}) {
  if (railwayEnvironmentId) {
    const railwayClientIp = getSingleValidIp(xRealIp);
    if (railwayClientIp) return railwayClientIp;
  }

  return normalizeClientIp(remoteAddress || handshakeAddress || 'unknown');
}

function resolveHttpClientIp(request, railwayEnvironmentId) {
  return resolveClientIp({
    railwayEnvironmentId,
    xRealIp: request.headers?.['x-real-ip'],
    remoteAddress: request.socket?.remoteAddress
  });
}

function getHttpRateLimitKey(request, railwayEnvironmentId) {
  return getIpRateLimitKey(resolveHttpClientIp(request, railwayEnvironmentId));
}

class IpRateLimiter {
  constructor({ maxAttempts, windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS }) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  attempt(clientIp, now = Date.now()) {
    const key = getIpRateLimitKey(clientIp);
    let entry = this.entries.get(key);

    if (!entry || now - entry.startedAt >= this.windowMs) {
      entry = { count: 0, startedAt: now };
      this.entries.set(key, entry);
    }

    entry.count += 1;
    return {
      allowed: entry.count <= this.maxAttempts,
      remaining: Math.max(0, this.maxAttempts - entry.count)
    };
  }

  prune(now = Date.now()) {
    for (const [clientIp, entry] of this.entries.entries()) {
      if (now - entry.startedAt >= this.windowMs) {
        this.entries.delete(clientIp);
      }
    }
  }
}

class PairingSecurity {
  constructor({
    invalidatedCodeTtlMs = DEFAULT_INVALIDATED_CODE_TTL_MS,
    randomInt = crypto.randomInt
  } = {}) {
    this.invalidatedCodeTtlMs = invalidatedCodeTtlMs;
    this.randomInt = randomInt;
    this.activeRooms = new Map();
    this.invalidatedCodes = new Map();
    this.socketRooms = new Map();
  }

  pruneInvalidatedCodes(now = Date.now()) {
    for (const [code, invalidatedAt] of this.invalidatedCodes.entries()) {
      if (now - invalidatedAt >= this.invalidatedCodeTtlMs) {
        this.invalidatedCodes.delete(code);
      }
    }
  }

  invalidateCode(code, now = Date.now()) {
    this.invalidatedCodes.set(code, now);
  }

  generateUniqueCode(now = Date.now()) {
    this.pruneInvalidatedCodes(now);

    for (let attempts = 0; attempts < 100; attempts += 1) {
      const code = this.randomInt(1000, 10000).toString();
      if (!this.activeRooms.has(code) && !this.invalidatedCodes.has(code)) {
        return code;
      }
    }

    throw new Error('Failed to generate unique code after 100 attempts');
  }

  createRoom(code, socketId, timeout) {
    const room = {
      occupants: new Set([socketId]),
      state: 'waiting',
      timeout
    };
    this.activeRooms.set(code, room);
    this.socketRooms.set(socketId, code);
    return room;
  }

  attemptJoin(rawCode, socketId, beforeJoin = () => {}) {
    const code = String(rawCode || '').trim();
    if (!/^\d{4}$/.test(code)) return this.connectFailed();

    let room = this.activeRooms.get(code);
    if (!this.isRoomJoinable(room, socketId)) return this.connectFailed();

    beforeJoin();

    room = this.activeRooms.get(code);
    if (!this.isRoomJoinable(room, socketId)) return this.connectFailed();

    room.occupants.add(socketId);
    room.state = 'paired';
    this.socketRooms.set(socketId, code);
    clearTimeout(room.timeout);
    room.timeout = null;

    return { ok: true, code, room };
  }

  isRoomJoinable(room, socketId) {
    return Boolean(
      room &&
      room.state === 'waiting' &&
      room.occupants.size === 1 &&
      !room.occupants.has(socketId)
    );
  }

  connectFailed() {
    return { ok: false, error: { message: CONNECT_FAILED } };
  }

  destroyRoom(code, now = Date.now()) {
    const room = this.activeRooms.get(code);
    if (!room) return null;

    clearTimeout(room.timeout);
    this.activeRooms.delete(code);
    for (const socketId of room.occupants) {
      if (this.socketRooms.get(socketId) === code) {
        this.socketRooms.delete(socketId);
      }
    }
    this.invalidateCode(code, now);
    return room;
  }

  expireRoom(code, expectedRoom, now = Date.now()) {
    const room = this.activeRooms.get(code);
    if (!room || room !== expectedRoom || room.state !== 'waiting') return null;
    return this.destroyRoom(code, now);
  }

  endRoomsForSocket(socketId, now = Date.now()) {
    const code = this.socketRooms.get(socketId);
    const room = code ? this.activeRooms.get(code) : null;
    if (!room || !room.occupants.has(socketId)) {
      this.socketRooms.delete(socketId);
      return [];
    }

    const occupants = Array.from(room.occupants);
    const state = room.state;
    this.destroyRoom(code, now);
    return [{ code, occupants, state }];
  }
}

module.exports = {
  CONNECT_FAILED,
  DEFAULT_INVALIDATED_CODE_TTL_MS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  getIpRateLimitKey,
  IpRateLimiter,
  getHttpRateLimitKey,
  normalizeClientIp,
  resolveClientIp,
  resolveHttpClientIp,
  PairingSecurity
};
