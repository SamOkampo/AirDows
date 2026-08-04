const express = require('express');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  getHttpRateLimitKey,
  IpRateLimiter,
  resolveClientIp,
  PairingSecurity
} = require('./pairing-security');
const {
  getAppPrivacyHeaders,
  getLegacyAppRedirect,
  sanitizePairingUrl
} = require('./public/js/pairing-link-privacy');

if (typeof process.loadEnvFile === 'function') {
  const localEnvPath = path.join(__dirname, '.env');
  if (fs.existsSync(localEnvPath)) {
    process.loadEnvFile(localEnvPath);
  }
}

const { MetricsStore } = require('./metrics-store');

const app = express();
const server = http.createServer(app);

// Secure CORS configuration: restrict to same origin or configured hosts
const getAllowedOrigins = () => {
  const envOrigins = process.env.ALLOWED_ORIGINS || '';
  const origins = envOrigins ? envOrigins.split(',').map(o => o.trim()).filter(Boolean) : [];
  
  // In development, allow localhost; in production, require explicit configuration
  if (process.env.NODE_ENV !== 'production') {
    origins.push('http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173');
  }
  
  return origins.length > 0 ? origins : ['*'];
};

const io = new Server(server, {
  cors: {
    origin: getAllowedOrigins(),
    methods: ["GET", "POST"],
    credentials: true,
    maxAge: 3600
  }
});

const PORT = process.env.PORT || 3000;
const ROOM_EXPIRATION_MS = 180000;  // 3 minutes: strict single-use expiration
const SESSION_RECOVERY_GRACE_MS = 60 * 1000;
const ICE_CONFIG_CACHE_MS = 10 * 60 * 1000;
const NETWORK_HEALTH_WINDOW_MS = 60 * 1000;
const MAX_NETWORK_HEALTH_EVENTS = 12;
const INVALIDATED_CODE_TTL_MS = 10 * 60 * 1000;
const SECURITY_CLEANUP_INTERVAL_MS = 60 * 1000;
const CODE_GENERATION_RATE_LIMIT_MAX = 10;
const JOIN_RATE_LIMIT_MAX = 30;
const SOCKET_CONNECTION_RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ADMIN_DASHBOARD_TOKEN = process.env.ADMIN_DASHBOARD_TOKEN || '';
const METRICS_DATABASE_URL = process.env.METRICS_DATABASE_URL || process.env.DATABASE_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALERT_MIN_SAMPLES = readEnvNumber('ALERT_MIN_SAMPLES', 20, 1, 10_000);
const ALERT_FAILURE_PERCENT = readEnvNumber('ALERT_FAILURE_PERCENT', 10, 1, 100);
const ALERT_RELAY_PERCENT = readEnvNumber('ALERT_RELAY_PERCENT', 35, 1, 100);
const ALERT_COOLDOWN_MS = readEnvNumber('ALERT_COOLDOWN_MS', 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);

let cachedIceConfig = null;
let cachedIceConfigExpiresAt = 0;
const alertState = new Map();

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getHttpRateLimitKey(req, process.env.RAILWAY_ENVIRONMENT_ID),
  message: 'Too many requests from this IP. Please try again in a minute.'
});

const codeGenerationLimiter = new IpRateLimiter({
  maxAttempts: CODE_GENERATION_RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS
});
const joinLimiter = new IpRateLimiter({
  maxAttempts: JOIN_RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS
});
const connectionLimiter = new IpRateLimiter({
  maxAttempts: SOCKET_CONNECTION_RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS
});

function getClientIp(socket) {
  // Railway is trusted to set X-Real-IP; all proxy IP headers are ignored elsewhere.
  return resolveClientIp({
    railwayEnvironmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    xRealIp: socket.handshake.headers['x-real-ip'],
    remoteAddress: socket.request?.socket?.remoteAddress,
    handshakeAddress: socket.handshake.address
  });
}

function maskIpAddress(ip) {
  if (!ip) return 'unknown';
  if (ip.includes(':')) return ip.substring(0, ip.lastIndexOf(':')) + ':****';
  return ip.split('.').slice(0, -1).join('.') + '.*';
}

function readEnvNumber(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function isTelegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function sendTelegramAlert(key, title, details, options = {}) {
  if (!isTelegramConfigured()) return { sent: false, reason: 'not-configured' };

  const now = Date.now();
  const lastSentAt = alertState.get(key) || 0;
  if (!options.force && now - lastSentAt < ALERT_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }

  alertState.set(key, now);
  const message = ['AirDows Alert', title, details, `UTC: ${new Date().toISOString()}`].join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
    });
    if (!response.ok) throw new Error(`Telegram API status ${response.status}`);
    console.info(`[AirDows] Telegram alert sent: ${key}`);
    return { sent: true };
  } catch (error) {
    console.error(`[AirDows] Telegram alert failed (${key}):`, error.message);
    return { sent: false, reason: 'delivery-failed' };
  }
}

function getStaticTurnIceServers() {
  const iceServers = [];

  if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    const urls = process.env.TURN_URLS.split(',').map((url) => url.trim()).filter(Boolean);
    const stunUrls = urls.filter((url) => url.startsWith('stun:'));
    const turnUrls = urls.filter((url) => url.startsWith('turn:') || url.startsWith('turns:'));

    stunUrls.forEach((url) => {
      iceServers.push({ urls: url });
    });

    if (turnUrls.length > 0) {
      iceServers.push({
        urls: turnUrls,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL
      });
    }
  }

  return iceServers;
}

function isValidIceServer(server) {
  return server && (
    typeof server.urls === 'string' ||
    (Array.isArray(server.urls) && server.urls.every((url) => typeof url === 'string'))
  );
}

async function getMeteredIceServers() {
  const apiKey = process.env.METERED_API_KEY;
  if (!apiKey) return null;

  const meteredDomain = process.env.METERED_DOMAIN || 'airdows.metered.live';
  const credentialsUrl = `https://${meteredDomain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(credentialsUrl);

  if (!response.ok) {
    throw new Error(`Metered TURN API failed with status ${response.status}`);
  }

  const iceServers = await response.json();
  if (!Array.isArray(iceServers) || !iceServers.every(isValidIceServer)) {
    throw new Error('Metered TURN API returned an invalid ICE server list');
  }

  return iceServers;
}

async function getIceConfig() {
  const now = Date.now();

  if (cachedIceConfig && cachedIceConfigExpiresAt > now) {
    return cachedIceConfig;
  }

  let iceServers = null;
  let source = 'fallback';

  try {
    iceServers = await getMeteredIceServers();
    if (iceServers && iceServers.length > 0) source = 'metered';
  } catch (err) {
    console.error('Failed to fetch Metered TURN credentials:', err.message);
  }

  if (!iceServers || iceServers.length === 0) {
    iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      ...getStaticTurnIceServers()
    ];
  }

  if (!iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
  })) {
    console.warn('No TURN server configured. Set METERED_API_KEY in the production environment.');
  }

  cachedIceConfig = { iceServers };
  cachedIceConfigExpiresAt = now + ICE_CONFIG_CACHE_MS;

  console.log('ICE config ready:', {
    source,
    servers: iceServers.length,
    hasRelay: iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
    })
  });

  return cachedIceConfig;
}

// Store active rooms and short-lived invalidated codes in memory only.
const pairingSecurity = new PairingSecurity({
  invalidatedCodeTtlMs: INVALIDATED_CODE_TTL_MS
});
const activeRooms = pairingSecurity.activeRooms;

function pruneInvalidatedCodes(now = Date.now()) {
  pairingSecurity.pruneInvalidatedCodes(now);
}

const securityCleanupInterval = setInterval(() => {
  const now = Date.now();
  pruneInvalidatedCodes(now);
  codeGenerationLimiter.prune(now);
  joinLimiter.prune(now);
  connectionLimiter.prune(now);
}, SECURITY_CLEANUP_INTERVAL_MS);
securityCleanupInterval.unref();

const metricsStore = new MetricsStore(METRICS_DATABASE_URL);
const networkHealthStats = {
  samples: 0,
  byRoute: Object.create(null),
  byOutcome: Object.create(null),
  bySpeed: Object.create(null),
  byDuration: Object.create(null),
  relayChunks: 0,
  relayEstimatedBytes: 0,
  startedAt: new Date().toISOString()
};

function incrementMetric(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

function normalizeNetworkHealth(payload) {
  const routes = new Set(['host', 'srflx', 'relay', 'unknown']);
  const outcomes = new Set(['completed', 'cancelled', 'failed']);
  const speedBuckets = new Set(['slow', 'moderate', 'fast', 'turbo', 'unknown']);
  const durationBuckets = new Set(['short', 'medium', 'long', 'unknown']);
  const direction = payload.direction === 'send' ? 'send' : 'receive';
  const relayChunks = Number.isSafeInteger(payload.relayChunks) && payload.relayChunks >= 0
    ? Math.min(payload.relayChunks, 10_000_000)
    : 0;
  const relayChunkSize = Number.isSafeInteger(payload.relayChunkSize) && payload.relayChunkSize >= 16 * 1024
    ? Math.min(payload.relayChunkSize, 1024 * 1024)
    : 0;

  return {
    route: routes.has(payload.route) ? payload.route : 'unknown',
    outcome: outcomes.has(payload.outcome) ? payload.outcome : 'failed',
    speed: speedBuckets.has(payload.speed) ? payload.speed : 'unknown',
    duration: durationBuckets.has(payload.duration) ? payload.duration : 'unknown',
    direction,
    relayChunks,
    relayChunkSize
  };
}

function recordNetworkHealth(payload) {
  const metric = normalizeNetworkHealth(payload);
  networkHealthStats.samples += 1;
  incrementMetric(networkHealthStats.byRoute, metric.route);
  incrementMetric(networkHealthStats.byOutcome, metric.outcome);
  incrementMetric(networkHealthStats.bySpeed, metric.speed);
  incrementMetric(networkHealthStats.byDuration, metric.duration);

  // Only the sending peer reports chunks, preventing receiver-side double counting.
  const relayEstimatedBytes = metric.route === 'relay' && metric.direction === 'send'
    ? metric.relayChunks * metric.relayChunkSize
    : 0;
  if (relayEstimatedBytes > 0) {
    networkHealthStats.relayChunks += metric.relayChunks;
    networkHealthStats.relayEstimatedBytes += relayEstimatedBytes;
  }

  metricsStore.record({
    samples: 1,
    completed: metric.outcome === 'completed' ? 1 : 0,
    failed: metric.outcome === 'failed' ? 1 : 0,
    cancelled: metric.outcome === 'cancelled' ? 1 : 0,
    host: metric.route === 'host' ? 1 : 0,
    srflx: metric.route === 'srflx' ? 1 : 0,
    relay: metric.route === 'relay' ? 1 : 0,
    unknownRoute: metric.route === 'unknown' ? 1 : 0,
    relayChunks: relayEstimatedBytes > 0 ? metric.relayChunks : 0,
    relayEstimatedBytes
  });
  evaluateOperationalAlerts();

  if (networkHealthStats.samples % 25 === 0) {
    console.info('[AirDows] Network health aggregate', networkHealthStats);
  }
}

function getSessionMetricTotals() {
  return {
    samples: networkHealthStats.samples,
    completed: networkHealthStats.byOutcome.completed || 0,
    failed: networkHealthStats.byOutcome.failed || 0,
    cancelled: networkHealthStats.byOutcome.cancelled || 0,
    host: networkHealthStats.byRoute.host || 0,
    srflx: networkHealthStats.byRoute.srflx || 0,
    relay: networkHealthStats.byRoute.relay || 0,
    unknownRoute: networkHealthStats.byRoute.unknown || 0,
    relayChunks: networkHealthStats.relayChunks,
    relayEstimatedBytes: networkHealthStats.relayEstimatedBytes,
    startedAt: networkHealthStats.startedAt
  };
}

function evaluateOperationalAlerts() {
  const totals = getSessionMetricTotals();
  if (totals.samples < ALERT_MIN_SAMPLES) return;

  const resolved = totals.completed + totals.failed;
  const failurePercent = resolved > 0 ? (totals.failed / resolved) * 100 : 0;
  const relayPercent = (totals.relay / totals.samples) * 100;

  if (failurePercent >= ALERT_FAILURE_PERCENT) {
    sendTelegramAlert(
      'transfer-failures',
      'Tasa de fallos elevada',
      `${failurePercent.toFixed(1)}% de fallos en ${resolved} transferencias resueltas. Umbral: ${ALERT_FAILURE_PERCENT}%.`
    ).catch(() => {});
  }

  if (relayPercent >= ALERT_RELAY_PERCENT) {
    sendTelegramAlert(
      'relay-usage',
      'Uso de TURN elevado',
      `${relayPercent.toFixed(1)}% de ${totals.samples} muestras usa relay TURN. Umbral: ${ALERT_RELAY_PERCENT}%.`
    ).catch(() => {});
  }
}

function formatDashboardMetrics(totals, persistenceEnabled) {
  const completed = totals.completed;
  const failed = totals.failed;
  const resolvedTransfers = completed + failed;
  const routeSamples = Math.max(totals.samples, 1);
  const host = totals.host;
  const srflx = totals.srflx;
  const relay = totals.relay;

  return {
    generatedAt: new Date().toISOString(),
    startedAt: totals.startedAt,
    samples: totals.samples,
    persistence: {
      enabled: persistenceEnabled,
      label: persistenceEnabled ? 'Histórico persistente' : 'Sesión actual (sin base de datos)'
    },
    transferSuccess: {
      completed,
      failed,
      percent: resolvedTransfers > 0 ? Number(((completed / resolvedTransfers) * 100).toFixed(1)) : 0
    },
    routes: {
      host,
      srflx,
      relay,
      hostPercent: Number(((host / routeSamples) * 100).toFixed(1)),
      directPercent: Number((((host + srflx) / routeSamples) * 100).toFixed(1)),
      relayPercent: Number(((relay / routeSamples) * 100).toFixed(1))
    },
    relay: {
      chunks: totals.relayChunks,
      estimatedGiB: Number((totals.relayEstimatedBytes / (1024 ** 3)).toFixed(3))
    }
  };
}

async function buildDashboardMetrics() {
  const persistedTotals = await metricsStore.getTotals();
  return formatDashboardMetrics(persistedTotals || getSessionMetricTotals(), Boolean(persistedTotals));
}

metricsStore.onError = ({ stage, message }) => {
  sendTelegramAlert(
    `database-${stage}`,
    'Persistencia de métricas degradada',
    `PostgreSQL no pudo ${stage === 'connection' ? 'conectar' : stage === 'write' ? 'guardar métricas' : 'leer métricas'}: ${message}`
  ).catch(() => {});
};

function timingSafeTokenMatch(expected, received) {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received || '');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function getAdminSessionValue() {
  return crypto
    .createHmac('sha256', ADMIN_DASHBOARD_TOKEN)
    .update('airdows-admin-session')
    .digest('base64url');
}

function getCookieValue(req, name) {
  const prefix = `${name}=`;
  const cookie = req.get('cookie') || '';
  const pair = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return pair ? decodeURIComponent(pair.slice(prefix.length)) : '';
}

function requireAdminDashboard(req, res, next) {
  if (!ADMIN_DASHBOARD_TOKEN) {
    return res.status(503).send('Admin dashboard is disabled. Set ADMIN_DASHBOARD_TOKEN in production.');
  }

  const authorization = req.get('authorization') || '';
  let token = '';

  if (authorization.startsWith('Bearer ')) {
    token = authorization.slice('Bearer '.length).trim();
  } else if (authorization.startsWith('Basic ')) {
    try {
      const credentials = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
      const separator = credentials.indexOf(':');
      const username = separator >= 0 ? credentials.slice(0, separator) : '';
      const password = separator >= 0 ? credentials.slice(separator + 1) : '';
      token = username === 'admin' ? password : '';
    } catch (error) {
      token = '';
    }
  }

  const hasValidToken = timingSafeTokenMatch(ADMIN_DASHBOARD_TOKEN, token);
  const hasValidSession = timingSafeTokenMatch(getAdminSessionValue(), getCookieValue(req, 'airdows_admin'));
  if (!hasValidToken && !hasValidSession) {
    res.set('WWW-Authenticate', 'Basic realm="AirDows Admin", charset="UTF-8"');
    return res.status(401).send('Unauthorized');
  }

  if (hasValidToken) {
    res.cookie('airdows_admin', getAdminSessionValue(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/admin'
    });
  }

  return next();
}

// ====================================================
// SECURE CODE GENERATION: Crypto-based, single-use, strict TTL
// ====================================================

function generateUniqueCode() {
  pruneInvalidatedCodes();
  return pairingSecurity.generateUniqueCode();
}

io.use((socket, next) => {
  const clientIp = getClientIp(socket);
  socket.data.clientIp = clientIp;
  socket.data.maskedIp = maskIpAddress(clientIp);

  if (!connectionLimiter.attempt(clientIp).allowed) {
    return next(new Error('Connection unavailable'));
  }

  return next();
});

io.on('connection', (socket) => {
  console.info(`[Connection] New socket session established`);
  
  socket.on('get-ice-config', async () => {
    try {
      socket.emit('ice-config', await getIceConfig());
    } catch (err) {
      console.error('[ICE] Failed to provide ICE config:', err.message);
      socket.emit('ice-config', {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
    }
  });

  // Aggregate-only reliability telemetry. No names, file sizes, IPs, room codes, or socket IDs are retained.
  socket.on('network-health', (payload = {}) => {
    const now = Date.now();
    const events = socket.data.networkHealthEvents || { count: 0, startedAt: now };
    if (now - events.startedAt > NETWORK_HEALTH_WINDOW_MS) {
      events.count = 0;
      events.startedAt = now;
    }
    if (events.count >= MAX_NETWORK_HEALTH_EVENTS) return;

    events.count += 1;
    socket.data.networkHealthEvents = events;
    recordNetworkHealth(payload);
  });

  // 1. Generate a new pairing code
  socket.on('generate-code', () => {
    const clientIp = socket.data.clientIp;
    
    // Global per-IP limit shared by every socket from the same client address.
    const limit = codeGenerationLimiter.attempt(clientIp);
    if (!limit.allowed) {
      socket.emit('error-message', { message: 'Too many code generation attempts. Please try again later.' });
      console.warn(`[RateLimit] Code generation blocked for ${socket.data.maskedIp}`);
      return;
    }

    leaveAllRooms(socket);

    let code;
    try {
      code = generateUniqueCode();
    } catch (err) {
      console.error('[CodeGen] Failed to generate code:', err.message);
      socket.emit('error-message', { message: 'Service temporarily unavailable. Please try again.' });
      return;
    }

    // Strict room TTL. Invalidated codes become eligible again after the short deny-list TTL.
    let room;
    const timeout = setTimeout(() => {
      if (pairingSecurity.expireRoom(code, room)) {
        io.in(code).socketsLeave(code);
        socket.emit('error-message', { message: 'Pairing code expired. Please generate a new code.' });
        console.info(`[Timeout] Pairing code expired after 3 minutes`);
      }
    }, ROOM_EXPIRATION_MS);

    room = pairingSecurity.createRoom(code, socket.id, timeout);
    socket.join(code);
    
    console.info(`[CodeGen] New pairing code generated for session`);
    socket.emit('code-generated', { code });
  });

  // 2. Join an existing pairing code
  socket.on('join-code', (payload = {}) => {
    const clientIp = socket.data.clientIp;

    // Count every join event against one IP-wide budget, regardless of socket or code.
    const limit = joinLimiter.attempt(clientIp);
    if (!limit.allowed) {
      socket.emit('error-message', { message: 'CONNECT_FAILED' });
      console.warn(`[RateLimit] Join attempts blocked for ${socket.data.maskedIp}`);
      return;
    }

    const rawCode = payload && typeof payload === 'object' ? payload.code : '';
    const result = pairingSecurity.attemptJoin(rawCode, socket.id, () => {
      leaveAllRooms(socket);
    });
    if (!result.ok) {
      socket.emit('error-message', result.error);
      return;
    }

    const { code, room } = result;
    socket.join(code);
    
    console.info(`[Pairing] New pairing session established`);

    emitPairedSession(room, false);
  });

  // 3. Recover a paired session using the participant's short-lived in-memory credential.
  socket.on('recover-session', (payload = {}) => {
    const limit = joinLimiter.attempt(socket.data.clientIp);
    if (!limit.allowed) {
      socket.emit('recovery-failed', { message: 'CONNECT_FAILED' });
      console.warn(`[RateLimit] Recovery attempts blocked for ${socket.data.maskedIp}`);
      return;
    }

    const recoveryToken = payload && typeof payload === 'object' ? payload.recoveryToken : '';
    const result = pairingSecurity.recoverSession(recoveryToken, socket.id, (recoveringCode) => {
      if (pairingSecurity.socketRooms.get(socket.id) !== recoveringCode) leaveAllRooms(socket);
    });
    if (!result.ok) {
      socket.emit('recovery-failed', { message: 'CONNECT_FAILED' });
      return;
    }

    socket.join(result.code);
    if (result.tokenDeliveryPending || result.recoveryToken) {
      socket.emit('recovery-token', { recoveryToken: result.recoveryToken });
    }
    if (result.alreadyConnected) return;
    if (!result.ready) {
      socket.emit('recovery-waiting');
      return;
    }

    console.info('[Recovery] Paired session restored');
    emitPairedSession(result.room, true);
  });

  socket.on('recovery-token-ack', (payload = {}) => {
    const recoveryToken = payload && typeof payload === 'object' ? payload.recoveryToken : '';
    const result = pairingSecurity.acknowledgeRecoveryToken(recoveryToken, socket.id);
    if (!result.ok) socket.emit('recovery-failed', { message: 'CONNECT_FAILED' });
  });

  // A client that gives up recovery explicitly releases the otherwise longer server grace period.
  socket.on('abandon-recovery', (payload = {}) => {
    const recoveryToken = payload && typeof payload === 'object' ? payload.recoveryToken : '';
    const result = pairingSecurity.abandonRecovery(recoveryToken, socket.id);
    if (!result.ok) return;

    io.to(result.code).emit('recovery-failed', { message: 'CONNECT_FAILED' });
    io.in(result.code).socketsLeave(result.code);
    console.info('[Recovery] Paired session recovery abandoned');
  });

  // 4. Forward Signaling Messages
  socket.on('signal', (payload = {}) => {
    const room = String(payload.room || '').trim();
    const data = payload.data;

    const activeRoom = activeRooms.get(room);
    const participant = pairingSecurity.getParticipantBySocket(activeRoom, socket.id);
    if (!room || !activeRoom || activeRoom.state !== 'paired' ||
        !activeRoom.occupants.has(socket.id) ||
        pairingSecurity.socketRooms.get(socket.id) !== room || !participant) {
      socket.emit('error-message', { message: 'Invalid signaling payload.' });
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      socket.emit('error-message', { message: 'Invalid signaling payload.' });
      return;
    }

    socket.to(room).emit('signal', { data, senderId: socket.id });
  });

  // 5. Manually leave/unpair
  socket.on('leave-room', () => {
    leaveAllRooms(socket);
  });

  // 6. Handle Disconnect
  socket.on('disconnect', () => {
    console.info('[Disconnect] Signaling session interrupted');
    handleSocketDisconnect(socket);
  });
});

function emitPairedSession(room, recovered) {
  if (!room || !room.participants) return;
  const participants = Array.from(room.participants.values());
  if (participants.length !== 2 || participants.some((participant) => !participant.socketId)) return;

  for (const participant of participants) {
    const peer = participants.find((candidate) => candidate !== participant);
    const payload = {
      role: participant.role,
      peerId: peer.socketId,
      code: room.code,
      recovered
    };
    if (!recovered) payload.recoveryToken = participant.recoveryToken;
    io.to(participant.socketId).emit('paired', payload);
  }
}

function scheduleRecoveryExpiry(code, room, recoveryGeneration) {
  if (!room || room.recoveryTimeout) return;
  room.recoveryTimeout = setTimeout(() => {
    const expiredRoom = pairingSecurity.expireRecoveringRoom(code, room, recoveryGeneration);
    if (!expiredRoom) return;

    io.to(code).emit('recovery-failed', { message: 'CONNECT_FAILED' });
    io.in(code).socketsLeave(code);
    console.info('[Recovery] Paired session recovery expired');
  }, SESSION_RECOVERY_GRACE_MS);
  if (typeof room.recoveryTimeout.unref === 'function') room.recoveryTimeout.unref();
}

function handleSocketDisconnect(socket) {
  const result = pairingSecurity.markSocketDisconnected(socket.id);
  if (!result) return;

  if (!result.recoverable || !result.room) {
    console.info('[Cleanup] Unpaired session destroyed');
    return;
  }

  socket.to(result.code).emit('peer-disconnected', { recoverable: true });
  scheduleRecoveryExpiry(result.code, result.room, result.recoveryGeneration);
  console.info('[Recovery] Waiting for paired participant to reconnect');
}

function leaveAllRooms(socket) {
  const endedRooms = pairingSecurity.endRoomsForSocket(socket.id);

  for (const { code } of endedRooms) {
    console.info(`[Leave] Peer left session`);
    socket.to(code).emit('peer-disconnected');
    io.in(code).socketsLeave(code);
    console.info(`[Cleanup] Session destroyed`);
  }
}

// ==========================================
// CONFIGURACIÓN DE RUTAS Y ARCHIVOS ESTÁTICOS
// ==========================================

// Aplicar el limitador de peticiones primero
app.use(apiLimiter);

app.get('/admin/dashboard', requireAdminDashboard, (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(__dirname, 'private', 'admin-dashboard.html'));
});

app.get('/admin/metrics', requireAdminDashboard, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await buildDashboardMetrics());
});

app.post('/admin/alerts/test', requireAdminDashboard, async (req, res) => {
  const result = await sendTelegramAlert(
    'telegram-test',
    'Prueba de alertas',
    'Telegram está conectado al monitoreo interno de AirDows.',
    { force: true }
  );
  if (!result.sent) return res.status(503).json(result);
  return res.json(result);
});

const publicPages = {
  '/como-funciona': 'como-funciona.html',
  '/privacidad': 'privacidad.html',
  '/seguridad': 'seguridad.html',
  '/pasar-archivos-iphone-a-pc': 'pasar-archivos-iphone-a-pc.html',
  '/pasar-archivos-android-a-pc': 'pasar-archivos-android-a-pc.html',
  '/enviar-videos-sin-perder-calidad': 'enviar-videos-sin-perder-calidad.html',
  '/en/how-it-works': 'how-it-works.html',
  '/en/privacy': 'privacy-en.html',
  '/en/security': 'security-en.html',
  '/en/iphone-to-pc': 'iphone-to-pc.html',
  '/en/android-to-pc': 'android-to-pc.html',
  '/en/send-videos-without-losing-quality': 'send-videos-en.html'
};

Object.entries(publicPages).forEach(([route, fileName]) => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', fileName));
  });
});

// REDIRECCIÓN FORZADA: Si el usuario escribe /app.html en la URL,
// lo pateamos automáticamente a /app para limpiar el navegador.
app.use((req, res, next) => {
  if (req.path === '/index.html') {
    return res.redirect(301, '/');
  }
  if (req.path === '/app.html') {
    const redirect = getLegacyAppRedirect(req.originalUrl, 'http://localhost');
    res.set(getAppPrivacyHeaders(redirect.sensitive));
    return res.redirect(redirect.sensitive ? 302 : 301, redirect.location);
  }
  const cleanPublicRoute = Object.entries(publicPages)
    .find(([, fileName]) => req.path === `/${fileName}`)?.[0];
  if (cleanPublicRoute) return res.redirect(301, cleanPublicRoute);
  next();
});

// 1. RUTA LIMPIA PARA LA APP: Responde en /app usando el archivo app.html
app.get('/app', (req, res) => {
  // A legacy ?code= request may reach the Railway edge; new fragment links never send the code here.
  const privacy = sanitizePairingUrl(req.originalUrl, 'http://localhost');
  res.set(getAppPrivacyHeaders(privacy.hadCodeParameter));
  res.sendFile(path.join(__dirname, 'public', 'app.html')); 
});

// 2. ARCHIVOS ESTÁTICOS GENERALES: Para imágenes, CSS, scripts, etc.
app.use(express.static(path.join(__dirname, 'public')));

// 3. ENCENDER EL SERVIDOR (Siempre al final)
async function startServer() {
  await metricsStore.initialize();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Signaling server running on http://localhost:${PORT}`);
    console.log(`Local network access via http://<YOUR_LOCAL_IP>:${PORT}`);
  });
}

async function shutdown() {
  await metricsStore.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
startServer().catch((error) => {
  console.error('Failed to start AirDows:', error);
  process.exit(1);
});
