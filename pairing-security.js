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
    randomInt = crypto.randomInt,
    randomBytes = crypto.randomBytes
  } = {}) {
    this.invalidatedCodeTtlMs = invalidatedCodeTtlMs;
    this.randomInt = randomInt;
    this.randomBytes = randomBytes;
    this.activeRooms = new Map();
    this.invalidatedCodes = new Map();
    this.socketRooms = new Map();
    this.recoveryTokens = new Map();
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
      code,
      occupants: new Set([socketId]),
      state: 'waiting',
      timeout,
      recoveryTimeout: null,
      recoveryGeneration: 0,
      participants: null
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
    this.createRecoveryParticipants(room);

    return { ok: true, code, room };
  }

  createRecoveryToken(reservedTokens = new Set()) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = this.randomBytes(32).toString('hex');
      if (!this.recoveryTokens.has(token) && !reservedTokens.has(token)) return token;
    }
    throw new Error('Failed to create recovery credential');
  }

  createRecoveryParticipants(room) {
    if (room.participants) return room.participants;

    const [initiatorId, receiverId] = Array.from(room.occupants);
    const reservedTokens = new Set();
    const initiatorToken = this.createRecoveryToken(reservedTokens);
    reservedTokens.add(initiatorToken);
    const receiverToken = this.createRecoveryToken(reservedTokens);
    const participants = [
      { role: 'initiator', socketId: initiatorId, recoveryToken: initiatorToken, bindingGeneration: 0 },
      { role: 'receiver', socketId: receiverId, recoveryToken: receiverToken, bindingGeneration: 0 }
    ];
    room.participants = new Map();

    for (const participant of participants) {
      room.participants.set(participant.recoveryToken, participant);
      this.recoveryTokens.set(participant.recoveryToken, { room, participant });
    }

    return room.participants;
  }

  getParticipantBySocket(room, socketId) {
    if (!room || !room.participants) return null;
    return Array.from(room.participants.values()).find((participant) => participant.socketId === socketId) || null;
  }

  rotateRecoveryToken(room, participant) {
    const previousToken = participant.recoveryToken;
    const recoveryToken = this.createRecoveryToken();
    room.participants.delete(previousToken);
    this.recoveryTokens.delete(previousToken);
    participant.recoveryToken = recoveryToken;
    participant.bindingGeneration += 1;
    room.participants.set(recoveryToken, participant);
    this.recoveryTokens.set(recoveryToken, { room, participant });
    return recoveryToken;
  }

  recoverSession(rawToken, socketId, beforeRecover = () => {}) {
    const token = String(rawToken || '').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) return this.connectFailed();

    let record = this.recoveryTokens.get(token);
    if (!this.isRecoveryRecordValid(record, socketId)) return this.connectFailed();

    if (record.participant.socketId === socketId) {
      const ready = Array.from(record.room.participants.values()).every((entry) => Boolean(entry.socketId));
      return { ok: true, code: record.room.code, ...record, ready, alreadyConnected: true };
    }

    beforeRecover(record.room.code);

    record = this.recoveryTokens.get(token);
    if (!this.isRecoveryRecordValid(record, socketId)) return this.connectFailed();

    const { room, participant } = record;
    participant.socketId = socketId;
    room.occupants.add(socketId);
    this.socketRooms.set(socketId, room.code);
    const recoveryToken = this.rotateRecoveryToken(room, participant);

    const ready = Array.from(room.participants.values()).every((entry) => Boolean(entry.socketId));
    room.state = ready ? 'paired' : 'recovering';
    if (ready) {
      clearTimeout(room.recoveryTimeout);
      room.recoveryTimeout = null;
      room.recoveryGeneration += 1;
    }

    return { ok: true, code: room.code, room, participant, recoveryToken, ready };
  }

  isRecoveryRecordValid(record, socketId) {
    if (!record || !record.room || !record.participant) return false;
    const { room, participant } = record;
    return this.activeRooms.get(room.code) === room &&
      (room.state === 'paired' || room.state === 'recovering') &&
      (!participant.socketId || participant.socketId === socketId);
  }

  markSocketDisconnected(socketId) {
    const code = this.socketRooms.get(socketId);
    const room = code ? this.activeRooms.get(code) : null;
    if (!room || !room.occupants.has(socketId)) {
      this.socketRooms.delete(socketId);
      return null;
    }

    if (room.state === 'waiting' || !room.participants) {
      return { code, room: this.destroyRoom(code), recoverable: false };
    }

    const participant = this.getParticipantBySocket(room, socketId);
    if (!participant) {
      return { code, room: this.destroyRoom(code), recoverable: false };
    }

    if (room.state === 'paired') room.recoveryGeneration += 1;
    participant.socketId = null;
    participant.bindingGeneration += 1;
    room.occupants.delete(socketId);
    this.socketRooms.delete(socketId);
    room.state = 'recovering';
    return {
      code,
      room,
      participant,
      recoverable: true,
      recoveryGeneration: room.recoveryGeneration
    };
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
    clearTimeout(room.recoveryTimeout);
    room.timeout = null;
    room.recoveryTimeout = null;
    this.activeRooms.delete(code);
    for (const socketId of room.occupants) {
      if (this.socketRooms.get(socketId) === code) {
        this.socketRooms.delete(socketId);
      }
    }
    if (room.participants) {
      for (const participant of room.participants.values()) {
        if (participant.socketId && this.socketRooms.get(participant.socketId) === code) {
          this.socketRooms.delete(participant.socketId);
        }
        this.recoveryTokens.delete(participant.recoveryToken);
        participant.recoveryToken = null;
        participant.socketId = null;
      }
      room.participants.clear();
      room.participants = null;
    }
    this.invalidateCode(code, now);
    return room;
  }

  expireRoom(code, expectedRoom, now = Date.now()) {
    const room = this.activeRooms.get(code);
    if (!room || room !== expectedRoom || room.state !== 'waiting') return null;
    return this.destroyRoom(code, now);
  }

  expireRecoveringRoom(code, expectedRoom, expectedGeneration = expectedRoom?.recoveryGeneration, now = Date.now()) {
    const room = this.activeRooms.get(code);
    if (!room || room !== expectedRoom || room.state !== 'recovering' ||
        room.recoveryGeneration !== expectedGeneration) return null;
    return this.destroyRoom(code, now);
  }

  abandonRecovery(rawToken, socketId, now = Date.now()) {
    const token = String(rawToken || '').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) return this.connectFailed();

    let record = this.recoveryTokens.get(token);
    if (!record) {
      const code = this.socketRooms.get(socketId);
      const room = code ? this.activeRooms.get(code) : null;
      const participant = this.getParticipantBySocket(room, socketId);
      if (room && participant && participant.bindingGeneration > 0) {
        record = { room, participant };
      }
    }
    if (!record || !record.room || !record.participant) return this.connectFailed();
    const { room, participant } = record;
    if (this.activeRooms.get(room.code) !== room ||
        (participant.socketId && participant.socketId !== socketId)) {
      return this.connectFailed();
    }

    const destroyedRoom = this.destroyRoom(room.code, now);
    return destroyedRoom
      ? { ok: true, code: room.code, room: destroyedRoom }
      : this.connectFailed();
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
