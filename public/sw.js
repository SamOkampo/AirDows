const CACHE_NAME = 'airdows-shell-v1';
const APP_SHELL = ['/app', '/style.css', '/js/app.js', '/js/socket-manager.js', '/js/webrtc-manager.js', '/js/qrcode-generator.js', '/js/qr-manager.js', '/js/local-ai-manager.js'];
const SHARE_DB_NAME = 'airdows-share';
const SHARE_STORE_NAME = 'pending';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  if (event.request.method === 'POST' && requestUrl.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

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
