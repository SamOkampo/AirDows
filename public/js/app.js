document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Managers
  const socketManager = new SocketManager();
  const webrtcManager = new WebRTCManager(socketManager);

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

  // Transfer Elements
  const connectionStatusText = document.getElementById('connection-status-text');
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
  let activeTransferMode = 'idle';
  let transferIsActive = false;
  let wakeLock = null;
  let sharedFilesPending = [];

  // --- HELPERS ---
  function translate(key) {
    return typeof t === 'function' ? t(key) : key;
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

    diagnosticMode.textContent = translate(modeKey);
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

  async function restoreSharedFiles() {
    if (!new URLSearchParams(window.location.search).has('shared')) return;
    if (!('indexedDB' in window)) return;

    const request = indexedDB.open('airdows-share', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending');
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('pending', 'readwrite');
      const store = transaction.objectStore('pending');
      const readRequest = store.get('latest');

      readRequest.onsuccess = () => {
        const payload = readRequest.result;
        if (payload && payload.files && payload.files.length) {
          sharedFilesPending = Array.from(payload.files);
          if (roomCode) enqueueFiles(sharedFilesPending);
        }
        store.delete('latest');
        window.history.replaceState({}, document.title, window.location.pathname);
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
      meta.textContent = formatBytes(item.file.size);

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

    selectedFiles.forEach((file) => {
      transferQueue.push({
        id: ++queueIdCounter,
        file,
        status: 'pending'
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

    if (activeQueueItem && activeQueueItem.id === id) {
      webrtcManager.cancelActiveTransfer();
      progressCard.classList.add('hidden');
      dropZone.classList.remove('hidden');
    }

    renderQueue();
  }

  async function processQueue() {
    if (isProcessingQueue) return;

    isProcessingQueue = true;

    while (true) {
      const nextItem = transferQueue.find(item => item.status === 'pending');
      if (!nextItem) break;

      activeQueueItem = nextItem;
      nextItem.status = 'sending';
      currentFileTransferSize = nextItem.file.size;
      renderQueue();

      try {
        await webrtcManager.sendFile(nextItem.file);
        if (nextItem.status !== 'cancelled') {
          nextItem.status = 'done';
        }
      } catch (err) {
        if (err.name === 'TransferCancelledError' || nextItem.status === 'cancelled') {
          nextItem.status = 'cancelled';
        } else {
          nextItem.status = 'error';
          showToast(`${translate('transfer_fail')}${err.message}`);
        }
      } finally {
        activeQueueItem = null;
        renderQueue();
      }
    }

    isProcessingQueue = false;
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
  socketManager.onConnect = () => {
    console.log('Socket.io connected');
    
    // Set a safety timeout: if no ICE config arrives in 5 seconds, use a default fallback
    setTimeout(() => {
      if (!webrtcManager.rtcConfig) {
        console.warn('ICE Config from server timed out. Using basic fallback.');
        webrtcManager.setIceConfig({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        // Check if we were waiting to initialize
        if (pendingPairing) {
          webrtcManager.initialize(pendingPairing.role, pendingPairing.code);
          pendingPairing = null;
        }
      }
    }, 5000);
  };

  socketManager.onIceConfig = (config) => {
    webrtcManager.setIceConfig(config);
    if (pendingPairing) {
      console.log('ICE Config received, initializing pending WebRTC connection');
      webrtcManager.initialize(pendingPairing.role, pendingPairing.code);
      pendingPairing = null;
    }
  };

  socketManager.onDisconnect = () => {
    showToast(translate('socket_disconnect'));
    resetApp();
  };

  socketManager.onCodeGenerated = (code) => {
    roomCode = code;
    
    // Display 4 digits
    d1.textContent = code[0];
    d2.textContent = code[1];
    d3.textContent = code[2];
    d4.textContent = code[3];

    // Show digits container
    codeDisplayWrapper.classList.remove('hidden');
    btnGenerate.classList.add('hidden');

    // Generate QR Code containing join URL
    const joinUrl = `${window.location.origin}/app?code=${code}`;
    qrcodeDiv.innerHTML = '';
    if (typeof QRManager === 'undefined') {
      showToast(translate('qr_library_fail'));
    } else {
      qrCodeInstance = QRManager.draw(qrcodeDiv, joinUrl, 150);
    }
  };

  socketManager.onPaired = ({ role, peerId, code }) => {
    console.log(`Paired as ${role} in room ${code}`);
    setPetState('connecting');
    roomCode = code;

    
    switchView('transfer');
    connectionStatusText.textContent = translate('conn_connecting');
    
    // Reset file views
    dropZone.classList.remove('hidden');
    progressCard.classList.add('hidden');
    completedCard.classList.add('hidden');
    clipboardTextInput.value = '';
    clipboardFeed.innerHTML = '';
    transferQueue = [];
    activeQueueItem = null;
    isProcessingQueue = false;
    renderQueue();

    if (sharedFilesPending.length) {
      const filesToQueue = sharedFilesPending;
      sharedFilesPending = [];
      enqueueFiles(filesToQueue);
    }

    // Initialize WebRTC connection (Check if we have config first)
    if (!webrtcManager.rtcConfig) {
      console.warn('Pairing happened before ICE config. Queuing initialization...');
      pendingPairing = { role, code };
    } else {
      webrtcManager.initialize(role, code);
    }
  };

  socketManager.onSignal = (data) => {
    webrtcManager.handleSignal(data);
  };

  socketManager.onPeerDisconnected = () => {
    showToast(translate('peer_disconnected'));
    resetApp();
  };

  socketManager.onError = (message) => {
    showToast(message);
  };

  // --- WEBRTC EVENT HANDLERS ---
  webrtcManager.onConnectionStateChange = (state) => {
    console.log('WebRTC Connection state changed to:', state);
    if (state === 'connected') {
      setPetState('idle');
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connectionStatusText.textContent = translate('p2p_active');
    } else if ((state === 'failed' || state === 'disconnected') && roomCode) {
      setPetState('error');
      scheduleReconnect();
    } else if (state === 'closed') {
      setPetState('error');
      if (roomCode) {
        scheduleReconnect();
      }
    }
  };

  function scheduleReconnect() {
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
      if (!roomCode) return;
      webrtcManager.reconnect();
    }, delay);
  }

  webrtcManager.onFileTransferStart = (fileName, totalBytes, isSending, options = {}) => {
    activeTransferMode = options.writeMode || 'send';
    transferIsActive = true;
    acquireTransferWakeLock();
    setPetState('transferring');
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
    setPetState('idle');
    progressCard.classList.add('hidden');
    networkDiagnostics.classList.add('hidden');
    completedCard.classList.remove('hidden');

    completedFileName.textContent = fileName;

    if (options.savedToDisk) {
      completedFileSize.textContent = translate('saved_to_disk');
      btnDownload.classList.add('hidden');
      appendHistoryItem(fileName, translate('saved_to_disk'), 'received');
    } else if (fileBlob) {
      // Received mode
      const sizeStr = formatBytes(fileBlob.size);
      completedFileSize.textContent = sizeStr;
      
      const fileUrl = URL.createObjectURL(fileBlob);
      btnDownload.href = fileUrl;
      btnDownload.setAttribute('download', fileName);
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
    const isTurboMode = activeTransferMode === 'disk' || activeTransferMode === 'send';
    setPetState(isTurboMode && metrics.speed >= 10 * 1024 * 1024 ? 'turbo' : 'transferring');
  };

  webrtcManager.onTransferError = () => {
    activeTransferMode = 'idle';
    transferIsActive = false;
    releaseTransferWakeLock();
    setPetState('error');
  };

  webrtcManager.onFileTransferCancelled = (fileName, isLocal) => {
    activeTransferMode = 'idle';
    transferIsActive = false;
    releaseTransferWakeLock();
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
    socketManager.generateCode();
  });

  btnJoin.addEventListener('click', () => {
    const code = joinCodeInput.value.trim();
    if (code.length !== 4) {
      showToast(translate('invalid_code'));
      return;
    }
    socketManager.joinCode(code);
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
    
    // Revoke object URL to free memory
    if (btnDownload.href && btnDownload.href.startsWith('blob:')) {
      URL.revokeObjectURL(btnDownload.href);
      btnDownload.href = '#';
    }
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
      showToast(`${translate('send_fail')}${err.message}`);
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
  function resetApp() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    transferIsActive = false;
    releaseTransferWakeLock();
    if (activeQueueItem) {
      webrtcManager.cancelActiveTransfer();
    }
    socketManager.leaveRoom();
    webrtcManager.close();
    roomCode = null;
    pendingPairing = null;
    lastProgressRenderTime = 0;
    transferQueue = [];
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

    // Revoke download url if active
    if (btnDownload.href && btnDownload.href.startsWith('blob:')) {
      URL.revokeObjectURL(btnDownload.href);
      btnDownload.href = '#';
    }

    switchView('setup');
  }

  // --- INITIATE CONNECTION ---
  socketManager.connect();
  restoreSharedFiles();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && transferIsActive) {
      acquireTransferWakeLock();
    }
  });

  // --- CHECK URL QUERY PARAMS FOR QR AUTO-JOIN ---
  const urlParams = new URLSearchParams(window.location.search);
  const codeParam = urlParams.get('code');
  if (codeParam && codeParam.length === 4) {
    console.log('Found query parameter code:', codeParam);
    joinCodeInput.value = codeParam;
    // Small timeout to allow socket connection to finish before joining
    setTimeout(() => {
      socketManager.joinCode(codeParam);
      // Clean query string from browser bar to keep it tidy
      window.history.replaceState({}, document.title, window.location.pathname);
    }, 500);
  }
});
