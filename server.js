const express = require('express');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

if (typeof process.loadEnvFile === 'function') {
  const localEnvPath = path.join(__dirname, '.env');
  if (fs.existsSync(localEnvPath)) {
    process.loadEnvFile(localEnvPath);
  }
}

const { MetricsStore } = require('./metrics-store');

const app = express();
// The production host sits behind a reverse proxy and forwards the client IP.
app.set('trust proxy', 1);
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
const ICE_CONFIG_CACHE_MS = 10 * 60 * 1000;
const NETWORK_HEALTH_WINDOW_MS = 60 * 1000;
const MAX_NETWORK_HEALTH_EVENTS = 12;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000;  // Clean stale rate limit entries every 60s
const RATE_LIMIT_ENTRY_TTL_MS = 60000;  // Entries older than 60s are evicted
const FREE_RELAY_BUDGET_BYTES = Math.max(
  0,
  Number.parseInt(process.env.FREE_RELAY_BUDGET_BYTES || String(250 * 1024 * 1024), 10) || 0
);
const MAX_RELAY_USAGE_REPORT_BYTES = 8 * 1024 * 1024;
const ADMIN_DASHBOARD_TOKEN = process.env.ADMIN_DASHBOARD_TOKEN || '';
const METRICS_DATABASE_URL = process.env.METRICS_DATABASE_URL || process.env.DATABASE_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALERT_MIN_SAMPLES = readEnvNumber('ALERT_MIN_SAMPLES', 20, 1, 10_000);
const ALERT_FAILURE_PERCENT = readEnvNumber('ALERT_FAILURE_PERCENT', 10, 1, 100);
const ALERT_RELAY_PERCENT = readEnvNumber('ALERT_RELAY_PERCENT', 35, 1, 100);
const ALERT_PRO_REQUIRED_COUNT = readEnvNumber('ALERT_PRO_REQUIRED_COUNT', 5, 1, 10_000);
const ALERT_COOLDOWN_MS = readEnvNumber('ALERT_COOLDOWN_MS', 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);

let cachedIceConfig = null;
let cachedIceConfigExpiresAt = 0;
const alertState = new Map();
let lastProRequiredAlertCount = 0;

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP. Please try again in a minute.'
});

// ====================================================
// ADVANCED RATE LIMITING: 3-dimensional (IP + Socket + Code)
// ====================================================

// Rate limiting entry: { ip, socketId, targetCode, count, startTime }
// Key format: "ip|socketId|targetCode" (no spaces, secure separators)
const rateLimitStore = new Map();

function getRateLimitKey(clientIp, socketId, targetCode = '') {
  return `${clientIp}|${socketId}|${targetCode}`;
}

function maskIpAddress(ip) {
  if (!ip) return 'unknown';
  if (ip.includes(':')) return ip.substring(0, ip.lastIndexOf(':')) + ':****';
  return ip.split('.').slice(0, -1).join('.') + '.*';
}

function checkRateLimit(clientIp, socketId, targetCode = '', maxAttempts = 10, windowMs = 60000) {
  const now = Date.now();
  const key = getRateLimitKey(clientIp, socketId, targetCode);
  
  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { count: 1, startTime: now });
    return { allowed: true, remaining: maxAttempts - 1 };
  }
  
  const entry = rateLimitStore.get(key);
  if (now - entry.startTime > windowMs) {
    rateLimitStore.set(key, { count: 1, startTime: now });
    return { allowed: true, remaining: maxAttempts - 1 };
  }
  
  entry.count += 1;
  if (entry.count > maxAttempts) {
    return { allowed: false, remaining: 0 };
  }
  
  return { allowed: true, remaining: maxAttempts - entry.count };
}

// Cleanup routine: evict stale rate limit entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.startTime > RATE_LIMIT_ENTRY_TTL_MS) {
      rateLimitStore.delete(key);
      evicted++;
    }
  }
  if (evicted > 0) {
    console.info(`[Security] Rate limit cleanup: evicted ${evicted} stale entries`);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

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

// Store active rooms and their occupants
const activeRooms = new Map();
const metricsStore = new MetricsStore(METRICS_DATABASE_URL);
const networkHealthStats = {
  samples: 0,
  byRoute: Object.create(null),
  byOutcome: Object.create(null),
  bySpeed: Object.create(null),
  byDuration: Object.create(null),
  relayChunks: 0,
  relayEstimatedBytes: 0,
  proRequiredEvents: 0,
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

function getRelayBudget(socket) {
  if (!socket.data.relayBudget) {
    socket.data.relayBudget = {
      limitBytes: FREE_RELAY_BUDGET_BYTES,
      usedBytes: 0,
      blocked: false
    };
  }
  return socket.data.relayBudget;
}

function emitProRequired(socket) {
  const budget = getRelayBudget(socket);
  if (budget.blocked) return;

  budget.blocked = true;
  networkHealthStats.proRequiredEvents += 1;
  metricsStore.record({ proRequiredEvents: 1 });
  if (networkHealthStats.proRequiredEvents - lastProRequiredAlertCount >= ALERT_PRO_REQUIRED_COUNT) {
    lastProRequiredAlertCount = networkHealthStats.proRequiredEvents;
    sendTelegramAlert(
      'relay-budget',
      'Límites Free alcanzados',
      `${networkHealthStats.proRequiredEvents} sesiones alcanzaron el límite relay en esta ejecución.`
    ).catch(() => {});
  }
  socket.emit('pro-required', {
    code: 'PRO_REQUIRED',
    plan: 'free',
    limitBytes: budget.limitBytes,
    usedBytes: budget.usedBytes
  });
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
    proRequiredEvents: networkHealthStats.proRequiredEvents,
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
      estimatedGiB: Number((totals.relayEstimatedBytes / (1024 ** 3)).toFixed(3)),
      freeBudgetMiB: Number((FREE_RELAY_BUDGET_BYTES / (1024 ** 2)).toFixed(0)),
      proRequiredEvents: totals.proRequiredEvents
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

// Track codes that failed validation or expired to prevent reuse
const invalidatedCodes = new Map();

function generateUniqueCode() {
  let code;
  const maxAttempts = 100;
  let attempts = 0;
  
  do {
    code = crypto.randomInt(1000, 10000).toString();
    attempts++;
  } while ((activeRooms.has(code) || invalidatedCodes.has(code)) && attempts < maxAttempts);
  
  if (attempts >= maxAttempts) {
    throw new Error('Failed to generate unique code after 100 attempts');
  }
  
  return code;
}

// Invalidate a code permanently (prevent reuse if it expires or fails auth)
function invalidateCode(code) {
  const now = Date.now();
  invalidatedCodes.set(code, now);
  
  // Clean up old invalidated codes after 10 minutes
  if (invalidatedCodes.size > 10000) {
    for (const [c, timestamp] of invalidatedCodes.entries()) {
      if (now - timestamp > 10 * 60 * 1000) {
        invalidatedCodes.delete(c);
      }
    }
  }
}

io.on('connection', (socket) => {
  // Get client IP (from X-Forwarded-For if behind reverse proxy)
  const clientIp = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || socket.handshake.address 
    || 'unknown';
  
  // Store masked IP in socket data for rate limiting
  socket.data.clientIp = clientIp;
  socket.data.maskedIp = maskIpAddress(clientIp);
  
  console.info(`[Connection] New socket session established`);
  
  const relayBudget = getRelayBudget(socket);
  socket.emit('relay-budget', {
    plan: 'free',
    limitBytes: relayBudget.limitBytes,
    usedBytes: relayBudget.usedBytes
  });

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

  socket.on('relay-usage', (payload = {}) => {
    const bytes = Number.isSafeInteger(payload.bytes) && payload.bytes > 0
      ? Math.min(payload.bytes, MAX_RELAY_USAGE_REPORT_BYTES)
      : 0;
    if (!bytes) return;

    const budget = getRelayBudget(socket);
    if (budget.blocked) return;
    budget.usedBytes += bytes;
    if (budget.usedBytes > budget.limitBytes) emitProRequired(socket);
  });

  socket.on('relay-budget-exhausted', () => {
    emitProRequired(socket);
  });

  // 1. Generate a new pairing code
  socket.on('generate-code', () => {
    const clientIp = socket.data.clientIp;
    
    // Rate limit: max 10 code generations per (IP + Socket) per 60 seconds
    const limit = checkRateLimit(clientIp, socket.id, '', 10, 60000);
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

    // Strict TTL: 3 minutes, then invalidate permanently
    const timeout = setTimeout(() => {
      const room = activeRooms.get(code);
      if (room && room.occupants.size < 2) {
        activeRooms.delete(code);
        invalidateCode(code);  // Prevent reuse
        socket.leave(code);
        socket.emit('error-message', { message: 'Pairing code expired. Please generate a new code.' });
        console.info(`[Timeout] Pairing code expired after 3 minutes`);
      }
    }, ROOM_EXPIRATION_MS);

    activeRooms.set(code, {
      occupants: new Set([socket.id]),
      timeout
    });
    socket.join(code);
    
    console.info(`[CodeGen] New pairing code generated for session`);
    socket.emit('code-generated', { code });
  });

  // 2. Join an existing pairing code
  socket.on('join-code', (payload = {}) => {
    const clientIp = socket.data.clientIp;
    const cleanCode = String(payload.code || '').trim();
    
    // Strict validation: must be exactly 4 digits, no exceptions
    if (!/^\d{4}$/.test(cleanCode)) {
      socket.emit('error-message', { message: 'CONNECT_FAILED' });
      return;
    }

    // Rate limit: max 15 join attempts per (IP + Socket + specific code) per 60 seconds
    const limit = checkRateLimit(clientIp, socket.id, cleanCode, 15, 60000);
    if (!limit.allowed) {
      socket.emit('error-message', { message: 'CONNECT_FAILED' });
      console.warn(`[RateLimit] Join attempts blocked for ${socket.data.maskedIp}`);
      return;
    }

    // OPAQUE RESPONSE: Same error for all failure scenarios
    const OPAQUE_ERROR = 'CONNECT_FAILED';

    if (!activeRooms.has(cleanCode)) {
      // Code doesn't exist OR expired OR already used
      invalidateCode(cleanCode);  // Prevent brute force on this code
      socket.emit('error-message', { message: OPAQUE_ERROR });
      return;
    }

    const room = activeRooms.get(cleanCode);
    const occupants = room.occupants;

    if (occupants.has(socket.id)) {
      socket.emit('error-message', { message: OPAQUE_ERROR });
      return;
    }

    if (occupants.size >= 2) {
      // Room is full
      invalidateCode(cleanCode);  // Mark as used, prevent further attempts
      socket.emit('error-message', { message: OPAQUE_ERROR });
      return;
    }

    leaveAllRooms(socket);

    occupants.add(socket.id);
    socket.join(cleanCode);
    clearTimeout(room.timeout);
    
    console.info(`[Pairing] New pairing session established`);

    const occupantsArray = Array.from(occupants);
    const initiatorId = occupantsArray[0];
    const joinerId = occupantsArray[1];

    io.to(initiatorId).emit('paired', { role: 'initiator', peerId: joinerId, code: cleanCode });
    io.to(joinerId).emit('paired', { role: 'receiver', peerId: initiatorId, code: cleanCode });
  });

  // 3. Forward Signaling Messages
  socket.on('signal', (payload = {}) => {
    const room = String(payload.room || '').trim();
    const data = payload.data;

    if (!room || !activeRooms.has(room) || !activeRooms.get(room).occupants.has(socket.id)) {
      socket.emit('error-message', { message: 'Invalid signaling payload.' });
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      socket.emit('error-message', { message: 'Invalid signaling payload.' });
      return;
    }

    socket.to(room).emit('signal', { data, senderId: socket.id });
  });

  // 4. Manually leave/unpair
  socket.on('leave-room', () => {
    leaveAllRooms(socket);
  });

  // 5. Handle Disconnect
  socket.on('disconnect', () => {
    console.info(`[Disconnect] Session terminated`);
    leaveAllRooms(socket);
  });
});

function leaveAllRooms(socket) {
  for (const [code, room] of activeRooms.entries()) {
    const occupants = room.occupants;

    if (occupants.has(socket.id)) {
      occupants.delete(socket.id);
      socket.leave(code);
      console.info(`[Leave] Peer left session`);

      socket.to(code).emit('peer-disconnected');

      if (occupants.size === 0) {
        clearTimeout(room.timeout);
        activeRooms.delete(code);
        invalidateCode(code);  // Ensure code cannot be reused
        console.info(`[Cleanup] Session destroyed`);
      }
    }
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
    return res.redirect(301, `/app${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
  }
  const cleanPublicRoute = Object.entries(publicPages)
    .find(([, fileName]) => req.path === `/${fileName}`)?.[0];
  if (cleanPublicRoute) return res.redirect(301, cleanPublicRoute);
  next();
});

// 1. RUTA LIMPIA PARA LA APP: Responde en /app usando el archivo app.html
app.get('/app', (req, res) => {
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
