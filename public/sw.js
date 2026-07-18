const CACHE_NAME = 'airdows-shell-v2';
const APP_SHELL = [
  '/',
  '/app',
  '/style.css',
  '/manifest.webmanifest',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/favicon.png',
  '/socket.io/socket.io.js',
  '/js/app.js',
  '/js/socket-manager.js',
  '/js/webrtc-manager.js',
  '/js/qrcode-generator.js',
  '/js/qr-manager.js',
  '/js/local-ai-manager.js'
];
const SHARE_DB_NAME = 'airdows-share';
const SHARE_STORE_NAME = 'pending';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith('airdows-shell-') && cacheName !== CACHE_NAME)
        .map((cacheName) => caches.delete(cacheName))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  if (event.request.method === 'POST' && requestUrl.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) return;
  if (requestUrl.pathname.startsWith('/socket.io/')) return;

  event.respondWith(handleGetRequest(event.request));
});

async function handleGetRequest(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.url.startsWith(self.location.origin)) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    if (request.mode === 'navigate') {
      return (await caches.match('/app')) || Response.error();
    }

    return Response.error();
  }
}

async function handleShareTarget(request) {
  const formData = await request.formData();
  const files = formData.getAll('files').filter((value) => value instanceof File);
  const payload = {
    files,
    title: formData.get('title') || '',
    text: formData.get('text') || '',
    createdAt: Date.now()
  };

  await savePendingShare(payload);
  return Response.redirect('/app?shared=1', 303);
}

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SHARE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePendingShare(payload) {
  const db = await openShareDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_STORE_NAME, 'readwrite');
    transaction.objectStore(SHARE_STORE_NAME).put(payload, 'latest');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
