function createPairingPrivacyFacade(helper) {
  const fallbackBootstrap = () => ({ code: null, entry: 'direct' });

  return Object.freeze({
    consumeBootstrap() {
      if (!helper || typeof helper.consumeBootstrap !== 'function') return fallbackBootstrap();
      try {
        const result = helper.consumeBootstrap();
        const code = result && typeof result.code === 'string' && /^\d{4}$/.test(result.code)
          ? result.code
          : null;
        return {
          code,
          entry: code && result.entry === 'pairing_link' ? 'pairing_link' : 'direct'
        };
      } catch (err) {
        return fallbackBootstrap();
      }
    },

    isAllowedAnalyticsEvent(eventName) {
      if (!helper || typeof helper.isAllowedAnalyticsEvent !== 'function') return false;
      try {
        return helper.isAllowedAnalyticsEvent(eventName) === true;
      } catch (err) {
        return false;
      }
    },

    sanitizeAnalyticsProperties(eventName, properties) {
      if (!helper || typeof helper.sanitizeAnalyticsProperties !== 'function') return null;
      try {
        const result = helper.sanitizeAnalyticsProperties(eventName, properties);
        return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
      } catch (err) {
        return null;
      }
    },

    buildPairingLink(origin, code) {
      const normalizedCode = String(code || '').trim();
      if (!/^\d{4}$/.test(normalizedCode)) {
        throw new Error('Pairing code must be exactly four digits');
      }

      if (helper && typeof helper.buildPairingLink === 'function') {
        try {
          const candidate = new URL(helper.buildPairingLink(origin, normalizedCode), origin);
          if (!candidate.searchParams.has('code') && candidate.hash === `#code=${normalizedCode}`) {
            return candidate.href;
          }
        } catch (err) {}
      }

      const fallback = new URL('/app', origin);
      fallback.hash = `code=${normalizedCode}`;
      return fallback.href;
    }
  });
}

function createReceivedBlobUrlLifecycle(downloadLink, urlApi) {
  let activeUrl = null;

  const clear = () => {
    if (!activeUrl) return false;
    const urlToRevoke = activeUrl;
    activeUrl = null;
    downloadLink.href = '#';
    downloadLink.removeAttribute('download');
    urlApi.revokeObjectURL(urlToRevoke);
    return true;
  };

  const install = (blob, fileName) => {
    clear();
    const nextUrl = urlApi.createObjectURL(blob);
    activeUrl = nextUrl;
    downloadLink.href = nextUrl;
    downloadLink.setAttribute('download', fileName);
    return nextUrl;
  };

  return Object.freeze({
    clear,
    install,
    getActiveUrl: () => activeUrl
  });
}

function clearReceivedBlobUrlOnPageHide(event, receivedBlobUrls) {
  if (event.persisted === true) return false;
  return receivedBlobUrls.clear();
}

function isAutomaticReconnectAllowed(sessionState) {
  return sessionState !== 'signaling-disconnected' &&
    sessionState !== 'recovering' &&
    sessionState !== 'manual-reconnect' &&
    sessionState !== 'manual-pairing';
}

function applyRecoveryState(currentState, nextState) {
  if (currentState === 'manual-reconnect' || currentState === 'manual-pairing') {
    return currentState;
  }
  return nextState;
}

function markManualActionDelivered(sessionState) {
  return sessionState === 'manual-reconnect' ? 'manual-pairing' : sessionState;
}

function clearAutomaticReconnect(timer, clearTimeoutFn) {
  if (timer !== null) clearTimeoutFn(timer);
  return { timer: null, attempts: 0 };
}

function runAutomaticReconnect({ sessionState, roomCode, reconnect }) {
  if (!roomCode || !isAutomaticReconnectAllowed(sessionState)) return false;
  reconnect();
  return true;
}

function submitManualJoin(rawCode, { onInvalid, onValid }) {
  const code = String(rawCode || '').trim();
  if (!/^\d{4}$/.test(code)) {
    onInvalid();
    return false;
  }
  onValid(code);
  return true;
}

function isPerformanceDiagnosticsRequested(helper, documentUrl) {
  try {
    return typeof helper === 'function' &&
      typeof helper.isRequested === 'function' &&
      helper.isRequested(documentUrl) === true;
  } catch (err) {
    return false;
  }
}

const pairingPrivacy = createPairingPrivacyFacade(window.PairingLinkPrivacy);
const pairingLinkBootstrap = pairingPrivacy.consumeBootstrap();

document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Managers
  const socketManager = new SocketManager();
  const webrtcManager = new WebRTCManager(socketManager, {
    performanceDiagnosticsEnabled: isPerformanceDiagnosticsRequested(
      window.AirDowsTransferPerformanceDiagnostics,
      document.URL
    )
  });
  const localAiManager = typeof LocalAIManager === 'function' ? new LocalAIManager() : null;

  // 2. DOM Elements
  const setupView = document.getElementById('setup-view');
  const transferView = document.getElementById('transfer-view');
  
  // Setup Elements
  const btnGenerate = document.getElementById('btn-generate');
  const codeDisplayWrapper = document.getElementById('code-display-wrapper');
  const d1 = document.getElementById('d1');
  const d2 = document.getElementById('d2');
  const d3 = document.getElementById('d3');
  const d4 = document.getElementById('d4');
  const qrcodeDiv = document.getElementById('qrcode');
  const joinCodeInput = document.getElementById('join-code-input');
  const btnJoin = document.getElementById('btn-join');
  const sharedFilesNotice = document.getElementById('shared-files-notice');
  const sharedFilesTitle = document.getElementById('shared-files-title');
  const sharedFilesDetail = document.getElementById('shared-files-detail');
  const onboardingGuide = document.getElementById('onboarding-guide');
  const onboardingProgress = document.getElementById('onboarding-progress');
  const onboardingCurrentTitle = document.getElementById('onboarding-current-title');
  const onboardingHint = document.getElementById('onboarding-hint');
  const btnToggleOnboarding = document.getElementById('btn-toggle-onboarding');
  const onboardingStepElements = Array.from(document.querySelectorAll('[data-onboarding-step]'));

  // Transfer Elements
  const connectionStatusText = document.getElementById('connection-status-text');
  const btnInstallApp = document.getElementById('btn-install-app');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const airPet = document.getElementById('air-pet');
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const clipboardTextInput = document.getElementById('clipboard-text-input');
  const btnSendText = document.getElementById('btn-send-text');
  const clipboardFeed = document.getElementById('clipboard-feed');

  // Progress Elements
  const progressCard = document.getElementById('progress-card');
  const progressFileName = document.getElementById('progress-file-name');
  const progressDirection = document.getElementById('progress-direction');
  const progressBytes = document.getElementById('progress-bytes');
  const progressSpeed = document.getElementById('progress-speed');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressPercent = document.getElementById('progress-percent');
  const networkDiagnostics = document.getElementById('network-diagnostics');
  const diagnosticMode = document.getElementById('diagnostic-mode');
  const connectionHealth = document.getElementById('connection-health');
  const connectionHealthTitle = document.getElementById('connection-health-title');
  const connectionHealthHint = document.getElementById('connection-health-hint');
  const btnCancelTransfer = document.getElementById('btn-cancel-transfer');
  const queueContainer = document.getElementById('queue-container');
  const queueSummary = document.getElementById('queue-summary');
  const queueList = document.getElementById('queue-list');
  const btnAddToQueue = document.getElementById('btn-add-to-queue');

  // Completed Elements
  const completedCard = document.getElementById('completed-card');
  const completedFileName = document.getElementById('completed-file-name');
  const completedFileSize = document.getElementById('completed-file-size');
  const btnDownload = document.getElementById('btn-download');
  const btnResetTransfer = document.getElementById('btn-reset-transfer');
  const receivedBlobUrls = createReceivedBlobUrlLifecycle(btnDownload, URL);

  // History Elements
  const historyContainer = document.getElementById('history-container');
  const historyList = document.getElementById('history-list');

  // Toast
  const errorToast = document.getElementById('error-toast');
  const errorText = document.getElementById('error-text');

  // State Variables
  let roomCode = null;
  let qrCodeInstance = null;
  let transferStartTime = 0;
  let lastProgressRenderTime = 0;
  let currentFileTransferSize = 0; // New: To track size for history reporting
  let pendingPairing = null; // New: To handle race condition
  let transferQueue = [];
  let activeQueueItem = null;
  let queueIdCounter = 0;
  let isProcessingQueue = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  let sessionRecoveryState = 'unpaired';
  let recoveryCleanupStarted = false;
  let preserveQueueAfterRecoveryFailure = false;
  let activeSocketGeneration = 0;
  let activeTransferMode = 'idle';
  let transferIsActive = false;
  let wakeLock = null;
  let sharedFilesPending = [];
  let p2pConnected = false;
  let deferredInstallPrompt = null;
  let pendingServiceWorker = null;
  let pwaUpdateDeferred = false;
  let networkHealthSample = null;
  let connectionEstablishedTracked = false;
  let lastTrackedRoute = 'unknown';
  let onboardingStep = 1;
  let onboardingComplete = false;
  let pendingAutoJoinCode = pairingLinkBootstrap.code;
  const appOpenEntry = pairingLinkBootstrap.entry;
  let autoJoinAttempted = false;
  pairingLinkBootstrap.code = null;

  // --- HELPERS ---
  function trackAnalytics(eventName, properties = {}) {
    const sendEvent = () => {
      if (!window.umami || typeof window.umami.track !== 'function') return false;
      if (!pairingPrivacy.isAllowedAnalyticsEvent(eventName)) return false;
      const safeProperties = pairingPrivacy.sanitizeAnalyticsProperties(eventName, properties);
      if (!safeProperties) return false;
      window.umami.track(eventName, safeProperties);
      return true;
    };

    if (sendEvent()) return;

    const sendWhenLoaded = () => sendEvent();
    if (document.readyState === 'complete') {
      setTimeout(sendWhenLoaded, 0);
    } else {
      window.addEventListener('load', sendWhenLoaded, { once: true });
    }
  }

  function getFileSizeBucket(bytes) {
    if (bytes < 10 * 1024 * 1024) return 'under_10mb';
    if (bytes < 100 * 1024 * 1024) return '10mb_100mb';
    if (bytes < 1024 * 1024 * 1024) return '100mb_1gb';
    return 'over_1gb';
  }

  function translate(key) {
    return typeof t === 'function' ? t(key) : key;
  }

  function translateTransferError(error) {
    const errorKeys = {
      INVALID_ENCRYPTED_CHUNK: 'invalid_encrypted_chunk',
      UNEXPECTED_TRANSFER_SIZE: 'unexpected_transfer_size',
      RECEIVER_NOT_READY: 'receiver_not_ready',
      RELAY_LIMIT_REACHED: 'relay_limit_required'
    };
    return errorKeys[error?.code] ? translate(errorKeys[error.code]) : (error?.message || translate('toast_error'));
  }

  const onboardingCopy = {
    1: { title: 'onboarding_step_1_title', hint: 'onboarding_step_1_hint' },
    2: { title: 'onboarding_step_2_title', hint: 'onboarding_step_2_hint' },
    3: { title: 'onboarding_step_3_title', hint: 'onboarding_step_3_hint' },
    4: { title: 'onboarding_step_4_title', hint: 'onboarding_step_4_hint' }
  };

  function updateOnboarding(step, options = {}) {
    if (!onboardingGuide) return;
    onboardingStep = Math.max(1, Math.min(4, Number(step) || 1));
    onboardingComplete = Boolean(options.complete);
    const titleKey = onboardingComplete
      ? 'onboarding_complete_title'
      : onboardingCopy[onboardingStep].title;

    onboardingProgress.setAttribute('data-i18n', 'onboarding_progress');
    onboardingProgress.setAttribute('data-i18n-step', String(onboardingStep));
    onboardingProgress.textContent = translate('onboarding_progress').replace('{step}', onboardingStep);
    onboardingCurrentTitle.setAttribute('data-i18n', titleKey);
    onboardingCurrentTitle.textContent = translate(titleKey);
    onboardingHint.textContent = translate(onboardingComplete
      ? 'onboarding_complete_hint'
      : onboardingCopy[onboardingStep].hint);

    onboardingStepElements.forEach((element) => {
      const elementStep = Number(element.dataset.onboardingStep);
      element.classList.toggle('is-current', !onboardingComplete && elementStep === onboardingStep);
      element.classList.toggle('is-complete', onboardingComplete || elementStep < onboardingStep);
    });
  }

  function setOnboardingCompact(compact, userInitiated = false) {
    if (!onboardingGuide || !btnToggleOnboarding) return;
    onboardingGuide.classList.toggle('is-compact', compact);
    btnToggleOnboarding.textContent = compact ? '?' : '×';
    btnToggleOnboarding.setAttribute('aria-expanded', String(!compact));
    const label = translate(compact ? 'onboarding_show' : 'onboarding_hide');
    btnToggleOnboarding.setAttribute('aria-label', label);
    btnToggleOnboarding.title = label;

    try {
      localStorage.setItem('airdows-onboarding-compact-v1', compact ? '1' : '0');
    } catch (_) {}

    if (userInitiated) {
      trackAnalytics(compact ? 'onboarding_dismissed' : 'onboarding_help_clicked', {
        step: onboardingStep
      });
    }
  }

  function initializeOnboarding() {
    if (!onboardingGuide) return;
    let compact = false;
    try {
      compact = localStorage.getItem('airdows-onboarding-compact-v1') === '1';
    } catch (_) {}
    updateOnboarding(1);
    setOnboardingCompact(compact);
    trackAnalytics('onboarding_shown', { mode: compact ? 'compact' : 'expanded' });
  }

  function showToast(message) {
    errorText.textContent = message;
    errorToast.classList.remove('hidden');
    setTimeout(() => {
      errorToast.classList.add('hidden');
    }, 4000);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function switchView(viewName) {
    if (viewName === 'setup') {
      setupView.classList.remove('hidden');
      transferView.classList.add('hidden');
    } else if (viewName === 'transfer') {
      setupView.classList.add('hidden');
      transferView.classList.remove('hidden');
    }
  }

  function setPetState(state) {
    if (!airPet) return;
    const stateClasses = {
      idle: 'air-pet--idle',
      transferring: 'air-pet--transferring',
      turbo: 'air-pet--turbo',
      error: 'air-pet--error'
    };
    airPet.className = `air-pet ${stateClasses[state] || stateClasses.idle} is-${state}`;
  }

  function updateTransferModeBadge(options = {}) {
    const modeKey = options.writeMode === 'disk'
      ? 'pro_mode_disk'
      : options.writeMode === 'memory'
        ? 'pro_mode_memory'
        : 'pro_mode_send';

    const baseLabel = translate(modeKey);
    diagnosticMode.textContent = options.performanceProfile
      ? `${baseLabel} · ${options.performanceProfile}`
      : baseLabel;
  }

  function getNetworkHealthPresentation(metrics) {
    const isSlow = metrics.speed > 0 && metrics.speed < 512 * 1024;
    if (isSlow) {
      return { tone: 'warning', title: 'health_slow_title', hint: 'health_slow_hint' };
    }
    if (metrics.connectionType === 'relay') {
      return { tone: 'warning', title: 'health_relay_title', hint: 'health_relay_hint' };
    }
    if (metrics.connectionType === 'host' || metrics.connectionType === 'srflx') {
      return { tone: 'good', title: 'health_direct_title', hint: 'health_direct_hint' };
    }
    return { tone: 'neutral', title: 'health_unknown_title', hint: 'health_unknown_hint' };
  }

  function updateConnectionHealth(metrics) {
    if (!connectionHealth || !connectionHealthTitle || !connectionHealthHint) return;
    const presentation = getNetworkHealthPresentation(metrics);
    connectionHealth.className = `connection-health tone-${presentation.tone}`;
    connectionHealthTitle.textContent = translate(presentation.title);
    connectionHealthHint.textContent = translate(presentation.hint);
  }

  function getSpeedBucket(speed) {
    if (!speed) return 'unknown';
    if (speed < 512 * 1024) return 'slow';
    if (speed < 3 * 1024 * 1024) return 'moderate';
    if (speed < 10 * 1024 * 1024) return 'fast';
    return 'turbo';
  }

  function getDurationBucket(durationMs) {
    if (!durationMs) return 'unknown';
    if (durationMs < 30 * 1000) return 'short';
    if (durationMs < 2 * 60 * 1000) return 'medium';
    return 'long';
  }

  function beginNetworkHealthSample(isSending, options = {}) {
    networkHealthSample = {
      startedAt: Date.now(),
      route: options.connectionType || 'unknown',
      peakSpeed: 0,
      direction: isSending ? 'send' : 'receive',
      relayChunks: 0,
      relayChunkSize: Number.isSafeInteger(options.chunkSize) ? options.chunkSize : 0
    };
  }

  function recordNetworkHealth(outcome) {
    if (!networkHealthSample) return;

    socketManager.sendNetworkHealth({
      route: networkHealthSample.route,
      outcome,
      speed: getSpeedBucket(networkHealthSample.peakSpeed),
      duration: getDurationBucket(Date.now() - networkHealthSample.startedAt),
      direction: networkHealthSample.direction,
      relayChunks: networkHealthSample.relayChunks,
      relayChunkSize: networkHealthSample.relayChunkSize
    });
    networkHealthSample = null;
  }

  async function acquireTransferWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;

    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch (error) {
      console.info('Wake Lock unavailable:', error.message);
    }
  }

  async function releaseTransferWakeLock() {
    if (!wakeLock) return;
    try {
      await wakeLock.release();
    } catch (error) {
      console.info('Wake Lock release failed:', error.message);
    } finally {
      wakeLock = null;
    }
  }

  function setNativeTransferKeepAlive(active) {
    const plugin = window.Capacitor?.Plugins?.AirDowsTransfer;
    if (!window.AirDowsRuntime?.isNative || !plugin) return;

    const operation = active ? plugin.start : plugin.stop;
    if (typeof operation !== 'function') return;

    operation.call(plugin).catch((error) => {
      console.info('Native transfer keep-alive unavailable:', error.message);
    });
  }

  function canApplyPwaUpdate() {
    return !transferIsActive && !activeQueueItem && !isProcessingQueue;
  }

  function applyPendingPwaUpdate() {
    if (!pendingServiceWorker) return;

    if (!canApplyPwaUpdate()) {
      pwaUpdateDeferred = true;
      return;
    }

    pwaUpdateDeferred = false;
    pendingServiceWorker.postMessage({ type: 'SKIP_WAITING' });
    pendingServiceWorker = null;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').then((registration) => {
      const handleWaitingWorker = (worker) => {
        if (!worker || !navigator.serviceWorker.controller) return;
        pendingServiceWorker = worker;
        showToast(translate('update_deferred'));
        applyPendingPwaUpdate();
      };

      handleWaitingWorker(registration.waiting);

      registration.addEventListener('updatefound', () => {
        const installingWorker = registration.installing;
        if (!installingWorker) return;

        installingWorker.addEventListener('statechange', () => {
          if (installingWorker.state === 'installed') {
            handleWaitingWorker(registration.waiting);
          }
        });
      });
    }).catch((error) => {
      console.info('Service Worker unavailable:', error.message);
    });
  }

  function setupInstallPrompt() {
    if (!btnInstallApp) return;

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      btnInstallApp.classList.remove('hidden');
      trackAnalytics('pwa_prompt_shown');
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      btnInstallApp.classList.add('hidden');
      showToast(translate('install_success'));
      trackAnalytics('pwa_installed');
    });

    btnInstallApp.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;

      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      btnInstallApp.classList.add('hidden');
    });
  }

  function updateSharedFilesNotice() {
    if (!sharedFilesNotice || !sharedFilesTitle || !sharedFilesDetail) return;
    const fileCount = sharedFilesPending.length;
    sharedFilesNotice.classList.toggle('hidden', fileCount === 0);
    if (!fileCount) return;

    sharedFilesTitle.textContent = fileCount === 1
      ? translate('shared_file_ready')
      : translate('shared_files_ready').replace('{count}', fileCount);
    sharedFilesDetail.textContent = `${sharedFilesPending[0].name}${fileCount > 1 ? ` +${fileCount - 1}` : ''} · ${translate('shared_files_connect_hint')}`;
  }

  function clearPendingSharedFiles() {
    if (!('indexedDB' in window)) return;
    const request = indexedDB.open('airdows-share', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('pending')) request.result.createObjectStore('pending');
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('pending', 'readwrite');
      transaction.objectStore('pending').delete('latest');
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => db.close();
    };
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  async function restoreSharedFiles() {
    if (!new URLSearchParams(window.location.search).has('shared')) return;
    if (!('indexedDB' in window)) return;

    const request = indexedDB.open('airdows-share', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('pending')) request.result.createObjectStore('pending');
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('pending', 'readwrite');
      const store = transaction.objectStore('pending');
      const readRequest = store.get('latest');

      readRequest.onsuccess = () => {
        const payload = readRequest.result;
        if (payload && payload.files && payload.files.length) {
          sharedFilesPending = Array.from(payload.files);
          if (roomCode) {
            const filesToQueue = sharedFilesPending;
            sharedFilesPending = [];
            enqueueFiles(filesToQueue);
            clearPendingSharedFiles();
          }
        }
        updateSharedFilesNotice();
        db.close();
      };
    };
  }

  function getQueueStatusLabel(status) {
    const labels = {
      pending: 'queue_pending',
      sending: 'queue_sending',
      done: 'queue_done',
      cancelled: 'queue_cancelled',
      error: 'queue_error'
    };
    return translate(labels[status] || 'queue_pending');
  }

  function renderQueue() {
    queueList.innerHTML = '';
    const visibleItems = transferQueue.filter(item => item.status !== 'removed');
    const waitingCount = transferQueue.filter(item => item.status === 'pending').length;

    queueSummary.textContent = `${waitingCount} ${translate('queue_waiting')}`;
    queueContainer.classList.toggle('hidden', visibleItems.length === 0);

    visibleItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = `queue-item ${item.status === 'sending' ? 'active' : item.status}`;

      const info = document.createElement('div');
      info.className = 'queue-file-info';

      const name = document.createElement('div');
      name.className = 'queue-file-name truncate';
      name.textContent = item.file.name;

      const meta = document.createElement('div');
      meta.className = 'queue-file-meta';
      meta.textContent = item.insight
        ? `${formatBytes(item.file.size)} · ${item.insight.label}`
        : formatBytes(item.file.size);

      info.appendChild(name);
      info.appendChild(meta);

      const status = document.createElement('span');
      status.className = 'queue-status';
      status.textContent = getQueueStatusLabel(item.status);

      const cancelButton = document.createElement('button');
      cancelButton.className = 'queue-cancel-btn';
      cancelButton.type = 'button';
      cancelButton.title = translate('btn_cancel_queued');
      cancelButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" stroke-linecap="round"/></svg>';
      cancelButton.addEventListener('click', () => cancelQueueItem(item.id));

      if (item.status === 'done' || item.status === 'cancelled' || item.status === 'error') {
        cancelButton.classList.add('hidden');
      }

      row.appendChild(info);
      row.appendChild(status);
      row.appendChild(cancelButton);
      queueList.appendChild(row);
    });
  }

  function enqueueFiles(files) {
    const selectedFiles = Array.from(files || []);
    if (!selectedFiles.length) return;

    const largestFileSize = Math.max(...selectedFiles.map(file => file.size));
    trackAnalytics('file_queued', {
      file_count: Math.min(selectedFiles.length, 10),
      size_bucket: getFileSizeBucket(largestFileSize)
    });

    selectedFiles.forEach((file) => {
      transferQueue.push({
        id: ++queueIdCounter,
        file,
        transferId: typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `queue-${Date.now()}-${queueIdCounter}`,
        selectedAt: performance.now(),
        status: 'pending',
        insight: localAiManager ? localAiManager.analyzeFile(file) : null
      });
    });

    completedCard.classList.add('hidden');
    renderQueue();
    processQueue();
  }

  function cancelQueueItem(id) {
    const item = transferQueue.find(queueItem => queueItem.id === id);
    if (!item || item.status === 'done' || item.status === 'cancelled' || item.status === 'error') return;

    item.status = 'cancelled';
    item.recoveryPending = false;

    if (activeQueueItem && activeQueueItem.id === id) {
      webrtcManager.cancelActiveTransfer();
      progressCard.classList.add('hidden');
      dropZone.classList.remove('hidden');
    }

    renderQueue();
  }

  async function processQueue() {
    if (isProcessingQueue || !p2pConnected) return;

    isProcessingQueue = true;

    while (true) {
      if (!p2pConnected) break;
      const nextItem = transferQueue.find(item => item.status === 'pending');
      if (!nextItem) break;

      activeQueueItem = nextItem;
      nextItem.status = 'sending';
      nextItem.recoveryPending = false;
      currentFileTransferSize = nextItem.file.size;
      renderQueue();

      try {
        await webrtcManager.sendFile(nextItem.file, {
          transferId: nextItem.transferId,
          selectedAt: nextItem.selectedAt
        });
        if (nextItem.status !== 'cancelled') {
          nextItem.status = 'done';
        }
      } catch (err) {
        if (nextItem.recoveryPending) {
          nextItem.status = 'pending';
          nextItem.recoveryPending = false;
          if (!p2pConnected) break;
        } else if (err.name === 'TransferCancelledError' || nextItem.status === 'cancelled') {
          nextItem.status = 'cancelled';
        } else if (err.name === 'ProRequiredError') {
          nextItem.status = 'error';
          showToast(translate('relay_limit_pro'));
        } else if (/connection (is not ready|closed)|data connection/i.test(err.message)) {
          nextItem.status = 'pending';
          p2pConnected = false;
          showToast(translate('connection_interrupted'));
          break;
        } else {
          nextItem.status = 'error';
          showToast(`${translate('transfer_fail')}${translateTransferError(err)}`);
        }
      } finally {
        activeQueueItem = null;
        renderQueue();
      }
    }

    isProcessingQueue = false;
    if (pwaUpdateDeferred) applyPendingPwaUpdate();
    if (p2pConnected && transferQueue.some((item) => item.status === 'pending')) {
      queueMicrotask(processQueue);
    }
  }

  function appendHistoryItem(fileName, fileSize, type) {
    const item = document.createElement('div');
    item.className = `history-item ${type}`;

    const icon = document.createElement('div');
    icon.className = 'history-item-icon';
    icon.innerHTML = type === 'sent' 
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';

    const info = document.createElement('div');
    info.className = 'history-item-info';
    
    const name = document.createElement('span');
    name.className = 'history-item-name truncate';
    name.textContent = fileName;

    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    const labelText = type === 'sent' ? t('outgoing_label') : t('incoming_label');
    meta.textContent = `${labelText} • ${fileSize}`;

    info.appendChild(name);
    info.appendChild(meta);
    item.appendChild(icon);
    item.appendChild(info);
    
    historyList.prepend(item);
    historyContainer.classList.remove('hidden');
  }

  function appendClipboardMessage(text, direction) {
    const card = document.createElement('div');
    card.className = `clipboard-message-card ${direction}`;

    const header = document.createElement('div');
    header.className = 'clipboard-message-header';

    const label = document.createElement('span');
    label.className = 'clipboard-message-label';
    label.textContent = direction === 'incoming' ? translate('incoming_label') : translate('outgoing_label');

    const copyButton = document.createElement('button');
    copyButton.className = 'clipboard-copy-btn';
    copyButton.type = 'button';
    copyButton.textContent = translate('btn_copy');
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(translate('toast_copied'));
      } catch (err) {
        showToast(translate('toast_copy_fail'));
      }
    });

    const body = document.createElement('p');
    body.className = 'clipboard-message-text';
    body.textContent = text;

    header.appendChild(label);
    header.appendChild(copyButton);
    card.appendChild(header);
    card.appendChild(body);
    clipboardFeed.prepend(card);
  }

  // --- SOCKET.IO EVENT HANDLERS ---
  socketManager.onConnect = ({ recovering = false, manualAction = false } = {}) => {
    console.log('Socket.io connected');
    if (!recovering && !manualAction) submitPendingAutoJoin();
    
    // Set a safety timeout: if no ICE config arrives in 5 seconds, use a default fallback
    setTimeout(() => {
      if (!webrtcManager.rtcConfig) {
        console.warn('ICE Config from server timed out. Using basic fallback.');
        webrtcManager.setIceConfig({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        // Check if we were waiting to initialize
        if (pendingPairing) {
          initializePairedConnection(pendingPairing);
          pendingPairing = null;
        }
      }
    }, 5000);
  };

  socketManager.onIceConfig = (config) => {
    webrtcManager.setIceConfig(config);
    if (pendingPairing) {
      console.log('ICE Config received, initializing pending WebRTC connection');
      initializePairedConnection(pendingPairing);
      pendingPairing = null;
    }
  };

  socketManager.onDisconnect = ({ recoverable = false } = {}) => {
    showToast(translate('socket_disconnect'));
    if (recoverable && roomCode) {
      beginSessionRecovery('signaling-disconnected');
      return;
    }
    resetApp();
  };

  socketManager.onCodeGenerated = (code) => {
    sessionRecoveryState = markManualActionDelivered(sessionRecoveryState);
    roomCode = code;
    trackAnalytics('room_created');
    updateOnboarding(2);
    
    // Display 4 digits
    d1.textContent = code[0];
    d2.textContent = code[1];
    d3.textContent = code[2];
    d4.textContent = code[3];

    // Show digits container
    codeDisplayWrapper.classList.remove('hidden');
    btnGenerate.classList.add('hidden');

    // Generate QR Code containing join URL
    const joinUrl = pairingPrivacy.buildPairingLink(window.location.origin, code);
    qrcodeDiv.innerHTML = '';
    if (typeof QRManager === 'undefined') {
      showToast(translate('qr_library_fail'));
    } else {
      qrCodeInstance = QRManager.draw(qrcodeDiv, joinUrl, 150);
    }
  };

  socketManager.onPaired = ({ role, peerId, code, recovered = false, connectionGeneration = 0 }) => {
    console.log('Pairing session established');
    if (!recovered) webrtcManager.markPairingEstablished();
    setPetState('connecting');
    roomCode = code;
    activeSocketGeneration = connectionGeneration;
    p2pConnected = false;
    if (!recovered) {
      sessionRecoveryState = markManualActionDelivered(sessionRecoveryState);
      webrtcManager.prepareForNewPairingSignals();
      connectionEstablishedTracked = false;
      trackAnalytics('room_joined', { role });
      updateOnboarding(2);
    }

    
    switchView('transfer');
    connectionStatusText.textContent = translate('conn_connecting');
    
    if (!recovered) {
      // A fresh manual pairing starts clean unless a failed recovery deliberately preserved the queue.
      dropZone.classList.remove('hidden');
      progressCard.classList.add('hidden');
      completedCard.classList.add('hidden');
      clipboardTextInput.value = '';
      clipboardFeed.innerHTML = '';
      if (!preserveQueueAfterRecoveryFailure) transferQueue = [];
      preserveQueueAfterRecoveryFailure = false;
      activeQueueItem = null;
      isProcessingQueue = false;
      applyPendingPwaUpdate();
      renderQueue();
    } else {
      completedCard.classList.add('hidden');
      dropZone.classList.remove('hidden');
      renderQueue();
    }

    if (sharedFilesPending.length) {
      const filesToQueue = sharedFilesPending;
      sharedFilesPending = [];
      updateSharedFilesNotice();
      enqueueFiles(filesToQueue);
      clearPendingSharedFiles();
    }

    // Initialize WebRTC connection (Check if we have config first)
    if (!webrtcManager.rtcConfig) {
      console.warn('Pairing happened before ICE config. Queuing initialization...');
      pendingPairing = { role, code, recovered };
    } else {
      initializePairedConnection({ role, code, recovered });
    }
  };

  socketManager.onSignal = (data, connectionGeneration) => {
    if (!activeSocketGeneration || connectionGeneration !== activeSocketGeneration) return;
    webrtcManager.handleSignal(data);
  };

  socketManager.onPeerDisconnected = ({ recoverable = false } = {}) => {
    showToast(translate('peer_disconnected'));
    if (recoverable && roomCode) {
      beginSessionRecovery('recovering');
      return;
    }
    failSessionRecovery();
  };

  socketManager.onRecoveryStateChange = (state) => {
    const nextState = applyRecoveryState(sessionRecoveryState, state);
    if (nextState === sessionRecoveryState) return;
    sessionRecoveryState = nextState;
    if (state === 'signaling-disconnected' || state === 'recovering') {
      beginSessionRecovery(state);
    }
  };

  socketManager.onRecoveryWaiting = () => {
    beginSessionRecovery('recovering');
  };

  socketManager.onRecoveryFailed = () => {
    failSessionRecovery();
  };

  socketManager.onManualActionPending = () => {
    const clearedReconnect = clearAutomaticReconnect(reconnectTimer, clearTimeout);
    reconnectTimer = clearedReconnect.timer;
    reconnectAttempts = clearedReconnect.attempts;
    sessionRecoveryState = 'manual-reconnect';
    p2pConnected = false;
    switchView('setup');
  };

  socketManager.onError = (message) => {
    showToast(message);
  };

  socketManager.onRelayBudget = (budget) => {
    webrtcManager.setRelayBudget(budget);
  };

  socketManager.onProRequired = () => {
    webrtcManager.handleProRequired();
    showToast(translate('relay_limit_required'));
  };

  // --- WEBRTC EVENT HANDLERS ---
  webrtcManager.onConnectionStateChange = (state) => {
    console.log('WebRTC Connection state changed to:', state);
    if (state === 'connected') {
      const recoveryCompleted = sessionRecoveryState === 'signaling-disconnected' ||
        sessionRecoveryState === 'recovering';
      if (recoveryCompleted) socketManager.completeRecovery();
      p2pConnected = true;
      recoveryCleanupStarted = false;
      sessionRecoveryState = 'paired';
      updateOnboarding(3);
      setPetState('idle');
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connectionStatusText.textContent = translate('p2p_active');
      if (!connectionEstablishedTracked) {
        connectionEstablishedTracked = true;
        trackAnalytics('connection_established');
      }
      processQueue();
    } else if ((state === 'failed' || state === 'disconnected') && roomCode) {
      p2pConnected = false;
      setPetState('error');
      scheduleReconnect();
    } else if (state === 'closed') {
      p2pConnected = false;
      setPetState('error');
      if (roomCode) {
        scheduleReconnect();
      }
    }
  };

  function scheduleReconnect() {
    if (!isAutomaticReconnectAllowed(sessionRecoveryState)) return;
    if (reconnectTimer || !roomCode || reconnectAttempts >= maxReconnectAttempts) {
      if (reconnectAttempts >= maxReconnectAttempts) {
        showToast(translate('p2p_lost'));
        resetApp();
      }
      return;
    }

    reconnectAttempts += 1;
    const delay = Math.min(1000 * (2 ** (reconnectAttempts - 1)), 10000);
    setPetState('connecting');
    connectionStatusText.textContent = `Reconectando (${reconnectAttempts}/${maxReconnectAttempts})...`;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      runAutomaticReconnect({
        sessionState: sessionRecoveryState,
        roomCode,
        reconnect: () => webrtcManager.reconnect()
      });
    }, delay);
  }

  function initializePairedConnection({ role, code, recovered = false }) {
    if (recovered) {
      webrtcManager.reconnect(role, code);
    } else {
      webrtcManager.initialize(role, code);
    }
  }

  function beginSessionRecovery(state) {
    if (!roomCode) return;
    sessionRecoveryState = state;
    p2pConnected = false;
    setPetState('connecting');
    connectionStatusText.textContent = 'Reconectando...';
    completedCard.classList.add('hidden');

    const deliveryAlreadyConfirmed = webrtcManager.activeSendTransfer?.terminalState === 'completed';
    if (activeQueueItem && activeQueueItem.status === 'sending' && !deliveryAlreadyConfirmed) {
      activeQueueItem.status = 'pending';
      activeQueueItem.recoveryPending = true;
    }

    if (!recoveryCleanupStarted) {
      recoveryCleanupStarted = true;
      webrtcManager.prepareForRecovery();
    }
    renderQueue();
  }

  function failSessionRecovery() {
    if (sessionRecoveryState === 'recovery-failed' && !roomCode) return;
    sessionRecoveryState = 'recovery-failed';
    showToast(translate('p2p_lost'));
    preserveQueueAfterRecoveryFailure = transferQueue.some((item) => item.status === 'pending' || item.status === 'sending');
    resetApp({ preserveQueue: preserveQueueAfterRecoveryFailure });
  }

  webrtcManager.onFileTransferStart = (fileName, totalBytes, isSending, options = {}) => {
    receivedBlobUrls.clear();
    activeTransferMode = options.writeMode || 'send';
    transferIsActive = true;
    acquireTransferWakeLock();
    setNativeTransferKeepAlive(true);
    beginNetworkHealthSample(isSending, options);
    lastTrackedRoute = 'unknown';
    trackAnalytics('transfer_started', {
      direction: isSending ? 'send' : 'receive',
      size_bucket: getFileSizeBucket(totalBytes),
      mode: options.writeMode || 'unknown'
    });
    updateConnectionHealth({ connectionType: 'unknown', speed: 0 });
    setPetState('transferring');
    updateOnboarding(4);
    dropZone.classList.add('hidden');
    completedCard.classList.add('hidden');
    progressCard.classList.remove('hidden');
    networkDiagnostics.classList.remove('hidden');

    if (!isSending) currentFileTransferSize = totalBytes; // Also track for received

    progressFileName.textContent = fileName;
    progressDirection.textContent = isSending ? translate('sending') : translate('receiving');
    progressBytes.textContent = `0 B / ${formatBytes(totalBytes)}`;
    progressSpeed.textContent = '0 KB/s';
    progressBarFill.style.width = '0%';
    progressPercent.textContent = '0%';
    btnCancelTransfer.classList.toggle('hidden', !isSending);
    updateTransferModeBadge(options);

    transferStartTime = Date.now();
    lastProgressRenderTime = 0;
  };

  webrtcManager.onFileTransferProgress = (bytesTransferred, totalBytes, fileName, isSending) => {
    const now = Date.now();
    const isComplete = bytesTransferred === totalBytes;

    if (!isComplete && now - lastProgressRenderTime < 150) {
      return;
    }

    lastProgressRenderTime = now;
    const percent = Math.min(100, Math.round((bytesTransferred / totalBytes) * 100));
    progressBarFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;

    progressBytes.textContent = `${formatBytes(bytesTransferred)} / ${formatBytes(totalBytes)}`;

    // Calculate Speed
    const elapsedSeconds = (Date.now() - transferStartTime) / 1000;
    if (elapsedSeconds > 0) {
      const speedBytesPerSec = bytesTransferred / elapsedSeconds;
      progressSpeed.textContent = `${formatBytes(speedBytesPerSec)}/s`;
    }
  };

  webrtcManager.onFileTransferComplete = (fileBlob, fileName, options = {}) => {
    activeTransferMode = 'idle';
    transferIsActive = false;
    releaseTransferWakeLock();
    setNativeTransferKeepAlive(false);
    if (networkHealthSample && options.connectionType === 'relay') {
      networkHealthSample.relayChunks = Math.max(networkHealthSample.relayChunks, options.relayChunks || 0);
      networkHealthSample.relayChunkSize = options.relayChunkSize || networkHealthSample.relayChunkSize;
    }
    const completedDirection = fileBlob || options.savedToDisk ? 'receive' : 'send';
    const completedRoute = networkHealthSample?.route || options.connectionType || 'unknown';
    trackAnalytics('transfer_completed', {
      direction: completedDirection,
      route: completedRoute,
      size_bucket: getFileSizeBucket(currentFileTransferSize)
    });
    recordNetworkHealth('completed');
    applyPendingPwaUpdate();
    setPetState('idle');
    updateOnboarding(4, { complete: true });
    progressCard.classList.add('hidden');
    networkDiagnostics.classList.add('hidden');
    if (sessionRecoveryState === 'signaling-disconnected' || sessionRecoveryState === 'recovering') {
      completedCard.classList.add('hidden');
    } else {
      completedCard.classList.remove('hidden');
    }

    completedFileName.textContent = fileName;

    if (options.savedToDisk) {
      receivedBlobUrls.clear();
      completedFileSize.textContent = translate('saved_to_disk');
      btnDownload.classList.add('hidden');
      appendHistoryItem(fileName, translate('saved_to_disk'), 'received');
    } else if (fileBlob) {
      // Received mode
      const sizeStr = formatBytes(fileBlob.size);
      completedFileSize.textContent = sizeStr;
      
      receivedBlobUrls.install(fileBlob, fileName);
      btnDownload.classList.remove('hidden');

      appendHistoryItem(fileName, sizeStr, 'received');

      // Premium UX: Auto-trigger download
      try {
        btnDownload.click();
      } catch (err) {
        console.error('Auto download failed, user must click button manually', err);
      }
    } else {
      // Sent mode
      receivedBlobUrls.clear();
      const sizeStr = formatBytes(currentFileTransferSize);
      completedFileSize.textContent = translate('sent_success');
      btnDownload.classList.add('hidden');
      
      appendHistoryItem(fileName, sizeStr, 'sent');
    }
  };

  webrtcManager.onClipboardMessage = (text) => {
    appendClipboardMessage(text, 'incoming');
  };

  webrtcManager.onNetworkDiagnostics = (metrics) => {
    networkDiagnostics.classList.remove('hidden');
    updateConnectionHealth(metrics);
    if (networkHealthSample) {
      networkHealthSample.route = metrics.connectionType || 'unknown';
      networkHealthSample.peakSpeed = Math.max(networkHealthSample.peakSpeed, metrics.speed || 0);
    }
    const route = metrics.connectionType || 'unknown';
    if (route !== 'unknown' && route !== lastTrackedRoute) {
      lastTrackedRoute = route;
      trackAnalytics('route_selected', { route });
    }
    const isTurboMode = activeTransferMode === 'disk' || activeTransferMode === 'send';
    setPetState(isTurboMode && metrics.speed >= 10 * 1024 * 1024 ? 'turbo' : 'transferring');
  };

  webrtcManager.onRelayUsage = ({ chunkSize, chunks }) => {
    if (!networkHealthSample || networkHealthSample.direction !== 'send') return;
    networkHealthSample.relayChunks += chunks;
    networkHealthSample.relayChunkSize = chunkSize;
  };

  webrtcManager.onTransferError = (details = {}) => {
    receivedBlobUrls.clear();
    activeTransferMode = 'idle';
    transferIsActive = false;
    releaseTransferWakeLock();
    setNativeTransferKeepAlive(false);
    trackAnalytics('transfer_failed', {
      direction: networkHealthSample?.direction || 'unknown',
      route: networkHealthSample?.route || 'unknown',
      failure_type: ['write', 'relay-budget', 'network', 'protocol'].includes(details.type) ? details.type : 'other'
    });
    recordNetworkHealth('failed');
    applyPendingPwaUpdate();
    setPetState('error');
    progressCard.classList.add('hidden');
    networkDiagnostics.classList.add('hidden');
    completedCard.classList.add('hidden');
    dropZone.classList.remove('hidden');
  };

  webrtcManager.onFileTransferCancelled = (fileName, isLocal) => {
    receivedBlobUrls.clear();
    activeTransferMode = 'idle';
    transferIsActive = false;
    releaseTransferWakeLock();
    setNativeTransferKeepAlive(false);
    trackAnalytics('transfer_cancelled', {
      direction: networkHealthSample?.direction || 'unknown',
      initiated_by: isLocal ? 'local' : 'remote'
    });
    recordNetworkHealth('cancelled');
    applyPendingPwaUpdate();
    setPetState('idle');
    progressCard.classList.add('hidden');
    networkDiagnostics.classList.add('hidden');
    completedCard.classList.add('hidden');

    if (!isLocal) {
      showToast(translate('remote_transfer_cancelled'));
      dropZone.classList.remove('hidden');
    }
  };

  // --- UI CONTROLS & LISTENERS ---
  btnGenerate.addEventListener('click', () => {
    webrtcManager.markPairingStarted();
    socketManager.generateCode();
  });

  if (btnToggleOnboarding) {
    btnToggleOnboarding.addEventListener('click', () => {
      setOnboardingCompact(!onboardingGuide.classList.contains('is-compact'), true);
    });
  }

  btnJoin.addEventListener('click', () => {
    const code = joinCodeInput.value.trim();
    submitManualJoin(code, {
      onInvalid: () => showToast(translate('invalid_code')),
      onValid: () => {
        webrtcManager.markPairingStarted();
        updateOnboarding(2);
        socketManager.joinCode(code);
      }
    });
  });

  // Support hitting Enter inside code input
  joinCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      btnJoin.click();
    }
  });

  btnDisconnect.addEventListener('click', () => {
    resetApp();
  });

  btnResetTransfer.addEventListener('click', () => {
    completedCard.classList.add('hidden');
    dropZone.classList.remove('hidden');
    updateOnboarding(3);
    receivedBlobUrls.clear();
  });

  btnSendText.addEventListener('click', () => {
    const text = clipboardTextInput.value;
    if (!text.trim()) {
      showToast(translate('empty_clipboard'));
      return;
    }

    try {
      webrtcManager.sendClipboardText(text);
      appendClipboardMessage(text, 'outgoing');
      clipboardTextInput.value = '';
    } catch (err) {
      showToast(`${translate('send_fail')}${translateTransferError(err)}`);
    }
  });

  btnCancelTransfer.addEventListener('click', () => {
    if (!activeQueueItem) return;
    cancelQueueItem(activeQueueItem.id);
    showToast(translate('transfer_cancelled'));
  });

  btnAddToQueue.addEventListener('click', () => {
    fileInput.click();
  });

  clipboardTextInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      btnSendText.click();
    }
  });

  // --- DRAG & DROP & CLICK FILE SELECT ---
  dropZone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      enqueueFiles(e.target.files);
      fileInput.value = '';
    }
  });

  // Drag listeners
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      enqueueFiles(files);
    }
  });

  // --- APP RESET & CLEANUP ---
  function resetApp({ preserveQueue = false } = {}) {
    receivedBlobUrls.clear();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    sessionRecoveryState = 'unpaired';
    p2pConnected = false;
    transferIsActive = false;
    releaseTransferWakeLock();
    setNativeTransferKeepAlive(false);
    if (!preserveQueue) recordNetworkHealth('cancelled');
    if (activeQueueItem && !preserveQueue) {
      webrtcManager.cancelActiveTransfer();
    }
    socketManager.leaveRoom();
    webrtcManager.close();
    roomCode = null;
    activeSocketGeneration = 0;
    recoveryCleanupStarted = false;
    connectionEstablishedTracked = false;
    lastTrackedRoute = 'unknown';
    pendingPairing = null;
    lastProgressRenderTime = 0;
    if (preserveQueue) {
      transferQueue.forEach((item) => {
        if (item.status === 'sending') {
          item.status = 'pending';
          item.recoveryPending = true;
        }
      });
    } else {
      transferQueue = [];
      preserveQueueAfterRecoveryFailure = false;
    }
    activeQueueItem = null;
    isProcessingQueue = false;

    // Reset setup UI
    joinCodeInput.value = '';
    fileInput.value = '';
    d1.textContent = '-';
    d2.textContent = '-';
    d3.textContent = '-';
    d4.textContent = '-';
    codeDisplayWrapper.classList.add('hidden');
    btnGenerate.classList.remove('hidden');
    clipboardTextInput.value = '';
    clipboardFeed.innerHTML = '';

    // History cleanup
    historyList.innerHTML = '';
    historyContainer.classList.add('hidden');
    renderQueue();

    switchView('setup');
  }

  // --- INITIATE CONNECTION ---
  async function bootstrapApplication() {
    try {
      await (window.AirDowsRuntime?.ready || Promise.resolve());
    } catch (error) {
      console.info('Runtime configuration bootstrap failed:', error.message);
    }

    trackAnalytics('app_open', {
      entry: appOpenEntry
    });
    initializeOnboarding();
    socketManager.connect();
    restoreSharedFiles();
    registerServiceWorker();
    setupInstallPrompt();
  }

  window.addEventListener('offline', () => {
    showToast(translate('offline_resume'));
  });

  window.addEventListener('online', () => {
    showToast(translate('connection_recovered'));
    socketManager.ensureConnected();
  });

  window.addEventListener('pagehide', (event) => {
    clearReceivedBlobUrlOnPageHide(event, receivedBlobUrls);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && transferIsActive) {
      acquireTransferWakeLock();
    }
  });

  function submitPendingAutoJoin() {
    if (autoJoinAttempted) return;
    autoJoinAttempted = true;

    const code = pendingAutoJoinCode;
    pendingAutoJoinCode = null;
    if (!code) return;

    webrtcManager.markPairingStarted();
    updateOnboarding(2);
    socketManager.joinCode(code);
  }

  bootstrapApplication();
});
