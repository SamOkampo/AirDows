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
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const ROOM_EXPIRATION_MS = 180000;
const JOIN_ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_JOIN_ATTEMPTS = 5;
const ICE_CONFIG_CACHE_MS = 10 * 60 * 1000;
const NETWORK_HEALTH_WINDOW_MS = 60 * 1000;
const MAX_NETWORK_HEALTH_EVENTS = 12;
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

// Helper to generate a unique 4-digit code
function generateUniqueCode() {
  let code;
  do {
    code = crypto.randomInt(1000, 10000).toString();
  } while (activeRooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
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
      console.error('Failed to provide ICE config:', err);
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
    leaveAllRooms(socket);

    const code = generateUniqueCode();
    const timeout = setTimeout(() => {
      const room = activeRooms.get(code);
      if (!room || room.occupants.size >= 2) return;

      activeRooms.delete(code);
      socket.leave(code);
      socket.emit('error-message', { message: 'Pairing code expired. Please generate a new code.' });
      console.log(`Room ${code} expired before pairing completed`);
    }, ROOM_EXPIRATION_MS);

    activeRooms.set(code, {
      occupants: new Set([socket.id]),
      timeout
    });
    socket.join(code);
    
    console.log(`Code ${code} generated for socket ${socket.id}`);
    socket.emit('code-generated', { code });
  });

  // 2. Join an existing pairing code
  socket.on('join-code', (payload = {}) => {
    const now = Date.now();
    const attempts = socket.data.joinAttempts || { count: 0, startedAt: now };
    if (now - attempts.startedAt > JOIN_ATTEMPT_WINDOW_MS) {
      attempts.count = 0;
      attempts.startedAt = now;
    }

    const rejectJoin = (message) => {
      attempts.count += 1;
      socket.data.joinAttempts = attempts;
      socket.emit('error-message', {
        message: attempts.count >= MAX_JOIN_ATTEMPTS
          ? 'Too many pairing attempts. Please wait a minute.'
          : message
      });
    };

    if (attempts.count >= MAX_JOIN_ATTEMPTS) {
      socket.emit('error-message', { message: 'Too many pairing attempts. Please wait a minute.' });
      return;
    }

    const cleanCode = String(payload.code || '').trim();
    
    if (!/^\d{4}$/.test(cleanCode)) {
      rejectJoin('Invalid code. Enter a 4-digit code.');
      return;
    }
    
    if (!activeRooms.has(cleanCode)) {
      rejectJoin('Invalid code. Code does not exist.');
      return;
    }

    const room = activeRooms.get(cleanCode);
    const occupants = room.occupants;

    if (occupants.has(socket.id)) {
      rejectJoin('You are already in this room.');
      return;
    }

    if (occupants.size >= 2) {
      rejectJoin('This room is full. Max 2 devices allowed.');
      return;
    }

    leaveAllRooms(socket);

    occupants.add(socket.id);
    socket.data.joinAttempts = { count: 0, startedAt: now };
    socket.join(cleanCode);
    clearTimeout(room.timeout);
    console.log(`Socket ${socket.id} joined room ${cleanCode}`);

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
      socket.emit('error-message', { message: 'Invalid signaling room.' });
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
    console.log(`Client disconnected: ${socket.id}`);
    leaveAllRooms(socket);
  });
});

function leaveAllRooms(socket) {
  for (const [code, room] of activeRooms.entries()) {
    const occupants = room.occupants;

    if (occupants.has(socket.id)) {
      occupants.delete(socket.id);
      socket.leave(code);
      console.log(`Socket ${socket.id} left room ${code}`);

      socket.to(code).emit('peer-disconnected');

      if (occupants.size === 0) {
        clearTimeout(room.timeout);
        activeRooms.delete(code);
        console.log(`Room ${code} destroyed (empty)`);
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

// REDIRECCIÓN FORZADA: Si el usuario escribe /app.html en la URL,
// lo pateamos automáticamente a /app para limpiar el navegador.
app.use((req, res, next) => {
  if (req.path === '/index.html') {
    return res.redirect(301, '/');
  }
  if (req.path === '/app.html') {
    return res.redirect(301, `/app${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
  }
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
