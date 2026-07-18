const express = require('express');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

if (typeof process.loadEnvFile === 'function') {
  const localEnvPath = path.join(__dirname, '.env');
  if (fs.existsSync(localEnvPath)) {
    process.loadEnvFile(localEnvPath);
  }
}

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
const ICE_CONFIG_CACHE_MS = 10 * 60 * 1000;

let cachedIceConfig = null;
let cachedIceConfigExpiresAt = 0;

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP. Please try again in a minute.'
});

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

// Helper to generate a unique 4-digit code
function generateUniqueCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (activeRooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

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
    const cleanCode = String(payload.code || '').trim();
    
    if (!/^\d{4}$/.test(cleanCode)) {
      socket.emit('error-message', { message: 'Invalid code. Enter a 4-digit code.' });
      return;
    }
    
    if (!activeRooms.has(cleanCode)) {
      socket.emit('error-message', { message: 'Invalid code. Code does not exist.' });
      return;
    }

    const room = activeRooms.get(cleanCode);
    const occupants = room.occupants;

    if (occupants.has(socket.id)) {
      socket.emit('error-message', { message: 'You are already in this room.' });
      return;
    }

    if (occupants.size >= 2) {
      socket.emit('error-message', { message: 'This room is full. Max 2 devices allowed.' });
      return;
    }

    leaveAllRooms(socket);

    occupants.add(socket.id);
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

// REDIRECCIÓN FORZADA: Si el usuario escribe /app.html en la URL,
// lo pateamos automáticamente a /app para limpiar el navegador.
app.use((req, res, next) => {
  if (req.path === '/app.html') {
    return res.redirect(301, '/app');
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
  console.log(`Local network access via http://<YOUR_LOCAL_IP>:${PORT}`);
});