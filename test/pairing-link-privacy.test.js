'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  bootstrapBrowser,
  buildPairingLink,
  consumeBootstrap,
  getAppPrivacyHeaders,
  getLegacyAppRedirect,
  getSafeCacheRequestUrl,
  initializeBrowser,
  isAllowedAnalyticsEvent,
  sanitizeAnalyticsProperties,
  sanitizePairingUrl
} = require('../public/js/pairing-link-privacy');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('a valid fragment pairing code is extracted', () => {
  const result = sanitizePairingUrl('https://airdows.com/app#code=1234');
  assert.equal(result.code, '1234');
  assert.equal(result.entry, 'pairing_link');
});

test('a valid legacy query pairing code is extracted', () => {
  const result = sanitizePairingUrl('https://airdows.com/app?code=1234');
  assert.equal(result.code, '1234');
  assert.equal(result.entry, 'pairing_link');
});

test('invalid pairing-code values are rejected', () => {
  for (const value of ['', '123', '12345', '12a4']) {
    const result = sanitizePairingUrl(`https://airdows.com/app?code=${value}`);
    assert.equal(result.code, null);
    assert.equal(result.entry, 'direct');
  }
});

test('duplicate pairing-code parameters are rejected', () => {
  const duplicateQuery = sanitizePairingUrl('https://airdows.com/app?code=1234&code=1234');
  const queryAndFragment = sanitizePairingUrl('https://airdows.com/app?code=1234#code=5678');
  const identicalQueryAndFragment = sanitizePairingUrl('https://airdows.com/app?code=1234#code=1234');

  assert.equal(duplicateQuery.code, null);
  assert.equal(queryAndFragment.code, null);
  assert.equal(identicalQueryAndFragment.code, null);
  assert.equal(queryAndFragment.entry, 'direct');
  assert.equal(identicalQueryAndFragment.entry, 'direct');
  assert.equal(queryAndFragment.sanitizedUrl, 'https://airdows.com/app');
  assert.equal(identicalQueryAndFragment.sanitizedUrl, 'https://airdows.com/app');

  let replacedUrl = null;
  const bootstrap = bootstrapBrowser({
    location: { href: 'https://airdows.com/app?code=1234#code=5678' },
    history: {
      state: null,
      replaceState(state, title, url) {
        replacedUrl = url;
      }
    },
    document: { title: 'AirDows' }
  });
  assert.deepEqual(bootstrap, { code: null, entry: 'direct' });
  assert.equal(replacedUrl, '/app');
});

test('all code parameters are removed from the query', () => {
  const result = sanitizePairingUrl('https://airdows.com/app?code=bad&shared=1&code=1234');
  const sanitized = new URL(result.sanitizedUrl);

  assert.equal(sanitized.searchParams.has('code'), false);
  assert.equal(sanitized.searchParams.get('shared'), '1');
});

test('all code parameters are removed from the fragment', () => {
  const result = sanitizePairingUrl('https://airdows.com/app#view=send&code=bad&code=1234');

  assert.equal(result.sanitizedUrl.includes('code='), false);
  assert.equal(new URL(result.sanitizedUrl).hash, '#view=send');
});

test('shared=1 is preserved while a legacy code is removed', () => {
  const result = sanitizePairingUrl('https://airdows.com/app?shared=1&code=1234');
  assert.equal(new URL(result.sanitizedUrl).search, '?shared=1');
});

test('unrelated query and fragment parameters are preserved', () => {
  const result = sanitizePairingUrl('https://airdows.com/app?lang=en&code=1234#view=send&source=qr');
  const sanitized = new URL(result.sanitizedUrl);

  assert.equal(sanitized.search, '?lang=en');
  assert.equal(sanitized.hash, '#view=send&source=qr');
});

test('the sanitized URL contains no pairing code', () => {
  const result = sanitizePairingUrl('https://airdows.com/app?code=1234#code=5678');
  assert.equal(result.sanitizedUrl.includes('1234'), false);
  assert.equal(result.sanitizedUrl.includes('5678'), false);
  assert.equal(result.sanitizedUrl.includes('code='), false);
});

test('the privacy bootstrap replaces history without writing persistent browser storage', () => {
  const storageWrites = [];
  let replacedUrl = null;
  const browserWindow = {
    location: { href: 'https://airdows.com/app?shared=1#code=1234' },
    history: {
      state: null,
      replaceState(state, title, url) {
        replacedUrl = url;
      }
    },
    document: {
      title: 'AirDows',
      set cookie(value) {
        storageWrites.push(['cookie', value]);
      }
    },
    localStorage: { setItem: (...args) => storageWrites.push(['localStorage', ...args]) },
    sessionStorage: { setItem: (...args) => storageWrites.push(['sessionStorage', ...args]) },
    indexedDB: { open: (...args) => storageWrites.push(['indexedDB', ...args]) }
  };

  const result = bootstrapBrowser(browserWindow);

  assert.deepEqual(result, { code: '1234', entry: 'pairing_link' });
  assert.equal(replacedUrl, '/app?shared=1');
  assert.deepEqual(storageWrites, []);
});

test('the bootstrap code can be consumed only once from short-lived memory', () => {
  const browserWindow = {
    location: { href: 'https://airdows.com/app#code=1234' },
    history: { state: null, replaceState() {} },
    document: { title: 'AirDows' }
  };

  initializeBrowser(browserWindow);

  assert.deepEqual(consumeBootstrap(), { code: '1234', entry: 'pairing_link' });
  assert.deepEqual(consumeBootstrap(), { code: null, entry: 'direct' });
});

test('new QR pairing links use a fragment and never a code query', () => {
  const link = buildPairingLink('https://airdows.com', '1234');
  assert.equal(link, 'https://airdows.com/app#code=1234');
  assert.equal(link.includes('?code='), false);
  assert.throws(() => buildPairingLink('https://airdows.com', '12345'));
});

test('the privacy bootstrap loads before Umami and application scripts', () => {
  const html = read('public/app.html');
  const privacyIndex = html.indexOf('/js/pairing-link-privacy.js');
  const umamiIndex = html.indexOf('data-website-id');
  const appIndex = html.indexOf('js/app.js');

  assert.ok(privacyIndex >= 0);
  assert.ok(privacyIndex < umamiIndex);
  assert.ok(privacyIndex < appIndex);
});

test('the referrer policy precedes every external resource in the application head', () => {
  const head = read('public/app.html').match(/<head>[\s\S]*?<\/head>/)[0];
  const referrerIndex = head.indexOf('<meta name="referrer" content="no-referrer">');
  const firstExternalResourceIndex = head.search(/<(?:script|link)\b[^>]*(?:src|href)=/);

  assert.ok(referrerIndex >= 0);
  assert.ok(referrerIndex < firstExternalResourceIndex);
});

test('the application page disables referrer transmission before loading scripts', () => {
  const html = read('public/app.html');
  const referrerIndex = html.indexOf('<meta name="referrer" content="no-referrer">');
  const privacyIndex = html.indexOf('/js/pairing-link-privacy.js');

  assert.ok(referrerIndex >= 0);
  assert.ok(referrerIndex < privacyIndex);
});

test('app_open analytics still distinguishes pairing_link from direct', () => {
  assert.equal(sanitizePairingUrl('https://airdows.com/app#code=1234').entry, 'pairing_link');
  assert.equal(sanitizePairingUrl('https://airdows.com/app?shared=1').entry, 'direct');
  assert.match(read('public/js/app.js'), /entry:\s*appOpenEntry/);
});

test('auto-join submits the in-memory code once and clears it immediately', () => {
  const app = read('public/js/app.js');

  assert.match(app, /if \(autoJoinAttempted\) return;/);
  assert.match(app, /pendingAutoJoinCode = null;[\s\S]*socketManager\.joinCode\(code\);/);
  assert.match(
    app,
    /socketManager\.onConnect = \(\{ recovering = false, manualAction = false \} = \{\}\) => \{[\s\S]*if \(!recovering && !manualAction\) submitPendingAutoJoin\(\);/
  );
  assert.doesNotMatch(app, /autoJoinFromUrl/);
});

test('analytics properties exclude pairing and content identifiers', () => {
  const properties = sanitizeAnalyticsProperties('room_joined', {
    role: 'receiver',
    code: '1234',
    roomCode: '1234',
    roomId: '1234',
    socketId: 'socket-secret',
    fileName: 'private.pdf',
    clipboard: 'secret text',
    url: 'https://airdows.com/app?code=1234'
  });

  assert.deepEqual(properties, { role: 'receiver' });
  assert.equal(JSON.stringify(properties).includes('1234'), false);
});

test('every current analytics event preserves its safe properties', () => {
  const matrix = {
    app_open: { entry: 'pairing_link' },
    onboarding_dismissed: { step: 2 },
    onboarding_help_clicked: { step: 3 },
    onboarding_shown: { mode: 'compact' },
    pwa_prompt_shown: {},
    pwa_installed: {},
    file_queued: { file_count: 2, size_bucket: '10mb_100mb' },
    room_created: {},
    room_joined: { role: 'receiver' },
    connection_established: {},
    transfer_started: { direction: 'send', size_bucket: 'under_10mb', mode: 'send' },
    route_selected: { route: 'relay' },
    transfer_completed: { direction: 'receive', route: 'host', size_bucket: '100mb_1gb' },
    transfer_failed: { direction: 'send', route: 'unknown', failure_type: 'network' },
    transfer_cancelled: { direction: 'receive', initiated_by: 'remote' }
  };

  for (const [eventName, properties] of Object.entries(matrix)) {
    assert.equal(isAllowedAnalyticsEvent(eventName), true, eventName);
    assert.deepEqual(sanitizeAnalyticsProperties(eventName, properties), properties, eventName);
  }

  const app = read('public/js/app.js');
  for (const eventName of Object.keys(matrix)) {
    assert.ok(app.includes(`'${eventName}'`), eventName);
  }
});

test('analytics rejects unknown events, sensitive properties, and four-digit values', () => {
  assert.equal(isAllowedAnalyticsEvent('room_1234'), false);
  assert.equal(isAllowedAnalyticsEvent('unknown_event'), false);

  const sanitized = sanitizeAnalyticsProperties('file_queued', {
    file_count: 1,
    size_bucket: 'private-1234',
    code: '1234',
    roomCode: '1234',
    filename: 'private.pdf',
    clipboard: 'private clipboard contents'
  });

  assert.deepEqual(sanitized, { file_count: 1 });
  assert.doesNotMatch(JSON.stringify(sanitized), /1234|private\.pdf|clipboard/);
  assert.match(read('public/js/app.js'), /isAllowedAnalyticsEvent\(eventName\)/);
  assert.doesNotMatch(read('public/js/app.js'), /trackAnalytics\([^\n]*\d{4}/);
});

test('production console logging does not print pairing codes or paired payloads', () => {
  const sources = [
    read('public/js/app.js'),
    read('public/js/socket-manager.js'),
    read('public/js/webrtc-manager.js')
  ].join('\n');

  assert.equal(sources.includes('Found query parameter code:'), false);
  assert.equal(sources.includes('Pairing code generated:'), false);
  assert.equal(sources.includes('Devices paired!', false), false);
  assert.equal(sources.includes('in room ${roomCode}'), false);
  assert.equal(sources.includes('in room ${code}'), false);
});

test('a Service Worker code request uses a sanitized cache URL', () => {
  const policy = getSafeCacheRequestUrl(
    'https://airdows.com/app?shared=1&code=1234',
    'https://airdows.com'
  );

  assert.equal(policy.sensitive, true);
  assert.equal(policy.url, 'https://airdows.com/app?shared=1');
  const worker = read('public/sw.js');
  assert.match(worker, /cache\.put\(cacheRequest,/);
  assert.doesNotMatch(worker, /cache\.put\(request,/);
});

test('combined share and legacy code flow preserves sharing without a sensitive cache key', () => {
  const result = sanitizePairingUrl('https://airdows.com/app?shared=1&code=1234');
  const policy = getSafeCacheRequestUrl(
    'https://airdows.com/app?shared=1&code=1234',
    'https://airdows.com'
  );
  const app = read('public/js/app.js');

  assert.equal(result.code, '1234');
  assert.equal(result.sanitizedPath, '/app?shared=1');
  assert.deepEqual(policy, {
    sensitive: true,
    url: 'https://airdows.com/app?shared=1'
  });
  assert.match(app, /new URLSearchParams\(window\.location\.search\)\.has\('shared'\)/);
  assert.match(app, /socketManager\.connect\(\);[\s\S]*restoreSharedFiles\(\);/);
});

test('a normal /app request remains cacheable', () => {
  const policy = getSafeCacheRequestUrl('https://airdows.com/app', 'https://airdows.com');
  assert.equal(policy.sensitive, false);
  assert.equal(policy.url, 'https://airdows.com/app');
});

test('/app?shared=1 remains a safe Web Share Target URL', () => {
  const policy = getSafeCacheRequestUrl('https://airdows.com/app?shared=1', 'https://airdows.com');
  assert.equal(policy.sensitive, false);
  assert.equal(new URL(policy.url).searchParams.get('shared'), '1');
  assert.match(read('public/sw.js'), /Response\.redirect\('\/app\?shared=1', 303\)/);
});

test('the Service Worker cache version bump removes old shell caches', () => {
  const worker = read('public/sw.js');
  assert.match(worker, /airdows-shell-v15/);
  assert.match(worker, /cacheName\.startsWith\('airdows-shell-'\)/);
  assert.match(worker, /caches\.delete\(cacheName\)/);
  assert.doesNotMatch(worker, /const CACHE_NAME = 'airdows-shell-v14'/);
});

test('Service Worker offline and route exclusions remain privacy-safe', () => {
  const worker = read('public/sw.js');
  const fragmentLink = buildPairingLink('https://airdows.com', '1234');
  const requestUrl = new URL(fragmentLink);

  assert.equal(`${requestUrl.origin}${requestUrl.pathname}${requestUrl.search}`, 'https://airdows.com/app');
  assert.match(worker, /caches\.match\('\/app'\)/);
  assert.match(worker, /requestUrl\.pathname\.startsWith\('\/socket\.io\/'\)/);
  assert.match(worker, /requestUrl\.pathname\.startsWith\('\/admin\/'\)/);
});

test('legacy sensitive app responses receive no-store and no-referrer headers', () => {
  assert.deepEqual(getAppPrivacyHeaders(true), {
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Expires: '0'
  });
  assert.deepEqual(getAppPrivacyHeaders(false), {
    'Referrer-Policy': 'no-referrer'
  });
});

test('/app.html converts one valid legacy code with a temporary protected redirect', () => {
  const redirect = getLegacyAppRedirect('/app.html?shared=1&code=1234', 'https://airdows.com');
  const server = read('server.js');

  assert.deepEqual(redirect, {
    sensitive: true,
    location: '/app?shared=1#code=1234'
  });
  assert.match(server, /redirect\.sensitive \? 302 : 301/);
  assert.match(server, /getAppPrivacyHeaders\(redirect\.sensitive\)/);
});

test('/app always applies no-referrer and combined legacy redirects remain temporary', () => {
  const redirect = getLegacyAppRedirect('/app.html?shared=1&code=1234', 'https://airdows.com');
  const server = read('server.js');

  assert.equal(redirect.location, '/app?shared=1#code=1234');
  assert.equal(getAppPrivacyHeaders(redirect.sensitive)['Cache-Control'], 'no-store');
  assert.equal(getAppPrivacyHeaders(redirect.sensitive)['Referrer-Policy'], 'no-referrer');
  assert.match(server, /app\.get\('\/app',[\s\S]*res\.set\(getAppPrivacyHeaders\(privacy\.hadCodeParameter\)\)/);
  assert.equal(getAppPrivacyHeaders(false)['Referrer-Policy'], 'no-referrer');
});
