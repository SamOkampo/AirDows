class SessionRecoveryState {
  constructor(options = {}) {
    this.timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 45_000;
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    this.onStateChange = options.onStateChange || null;
    this.onTimeout = options.onTimeout || null;
    this.state = 'unpaired';
    this.session = null;
    this.timeout = null;
  }

  isValidSession(session) {
    return Boolean(
      session &&
      /^[a-f0-9]{64}$/.test(String(session.recoveryToken || '')) &&
      /^\d{4}$/.test(String(session.code || '')) &&
      (session.role === 'initiator' || session.role === 'receiver')
    );
  }

  establish(session, recovered = false) {
    if (!this.isValidSession(session)) return false;
    this.clearTimer();
    this.session = {
      recoveryToken: session.recoveryToken,
      code: session.code,
      role: session.role
    };
    this.setState(recovered ? 'recovering' : 'paired');
    if (recovered) this.ensureTimer();
    return true;
  }

  updateRecoveryCredential(session) {
    if (!this.isValidSession(session) || !this.session ||
        session.code !== this.session.code || session.role !== this.session.role ||
        !['signaling-disconnected', 'recovering'].includes(this.state)) return false;
    this.session = {
      recoveryToken: session.recoveryToken,
      code: session.code,
      role: session.role
    };
    this.setState('recovering');
    this.ensureTimer();
    return true;
  }

  completeRecovery() {
    if (!this.session || this.state !== 'recovering') return false;
    this.clearTimer();
    this.setState('recovered');
    return true;
  }

  markSignalingDisconnected() {
    if (!this.session || ['recovery-failed', 'unpaired'].includes(this.state)) return false;
    this.setState('signaling-disconnected');
    this.ensureTimer();
    return true;
  }

  markRecovering() {
    if (!this.session || this.state === 'recovery-failed') return false;
    this.setState('recovering');
    this.ensureTimer();
    return true;
  }

  fail() {
    if (!this.session || !['signaling-disconnected', 'recovering'].includes(this.state)) return false;
    this.clearTimer();
    this.session = null;
    this.setState('recovery-failed');
    return true;
  }

  reset() {
    this.clearTimer();
    this.session = null;
    this.setState('unpaired');
  }

  ensureTimer() {
    if (this.timeout) return;
    this.timeout = this.setTimeoutFn(() => {
      this.timeout = null;
      const expiredSession = this.session ? { ...this.session } : null;
      if (!this.fail()) return;
      if (this.onTimeout) this.onTimeout(expiredSession);
    }, this.timeoutMs);
    if (typeof this.timeout?.unref === 'function') this.timeout.unref();
  }

  clearTimer() {
    if (!this.timeout) return;
    this.clearTimeoutFn(this.timeout);
    this.timeout = null;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (this.onStateChange) this.onStateChange(state);
  }
}

class SocketManager {
  constructor(options = {}) {
    this.socket = null;
    this.connectionGeneration = 0;
    
    // Event listener callbacks
    this.onCodeGenerated = null;
    this.onPaired = null; // ({ role, peerId, code })
    this.onSignal = null; // (data)
    this.onPeerDisconnected = null;
    this.onError = null; // (message)
    this.onConnect = null;
    this.onDisconnect = null;
    this.onIceConfig = null; // New: Callback for ICE configuration
    this.onRelayBudget = null;
    this.onProRequired = null;
    this.onRecoveryStateChange = null;
    this.onRecoveryWaiting = null;
    this.onRecoveryFailed = null;
    this.recoveryRequestInFlight = false;
    this.recoveryRequestGeneration = 0;
    this.acceptedRecoveryGeneration = 0;
    this.pendingAbandonSession = null;
    this.recovery = new SessionRecoveryState({
      timeoutMs: options.recoveryTimeoutMs,
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
      onStateChange: (state) => {
        if (this.onRecoveryStateChange) this.onRecoveryStateChange(state);
      },
      onTimeout: (session) => {
        this.recoveryRequestInFlight = false;
        this.abandonRecovery(session);
        if (this.onRecoveryFailed) this.onRecoveryFailed('CONNECT_FAILED');
      }
    });
  }

  connect() {
    const runtime = window.AirDowsRuntime;
    const signalingUrl = runtime?.getSignalingUrl?.() || '';

    if (runtime?.isNative && !signalingUrl) {
      const message = 'La app nativa necesita AIRDOWS_SIGNALING_URL para conectarse al servidor.';
      console.error(message);
      if (this.onError) this.onError(message);
      return;
    }

    // The browser uses its current origin; the native shell uses the configured HTTPS backend.
    const socket = io(signalingUrl || undefined, {
      transports: ['websocket', 'polling'],
      timeout: 10000,
      reconnection: true
    });
    this.socket = socket;
    let socketConnectionGeneration = 0;
    let connectionActive = false;

    socket.on('connect', () => {
      if (this.socket !== socket || connectionActive) return;
      connectionActive = true;
      const generation = ++this.connectionGeneration;
      socketConnectionGeneration = generation;
      this.flushPendingAbandon();
      const shouldRecover = Boolean(this.recovery.session) &&
        ['signaling-disconnected', 'recovering'].includes(this.recovery.state);
      if (shouldRecover) this.recovery.markRecovering();
      console.log('Connected to signaling server');
      if (this.onConnect) this.onConnect({ recovering: shouldRecover, generation });
      
      // Request ICE config immediately on connection
      this.requestIceConfig();
      if (shouldRecover) this.recoverSession();
    });

    socket.on('ice-config', (config) => {
      if (this.socket !== socket) return;
      console.log('Received ICE configuration from server');
      if (this.onIceConfig) this.onIceConfig(config);
    });

    socket.on('relay-budget', (budget) => {
      if (this.socket !== socket) return;
      if (this.onRelayBudget) this.onRelayBudget(budget);
    });

    socket.on('pro-required', (details) => {
      if (this.socket !== socket) return;
      if (this.onProRequired) this.onProRequired(details);
    });

    socket.on('code-generated', (data) => {
      if (this.socket !== socket) return;
      console.log('Pairing code generated');
      if (this.onCodeGenerated) this.onCodeGenerated(data.code);
    });

    socket.on('paired', (data) => {
      if (this.socket !== socket) return;
      if (!data || typeof data !== 'object') return;
      if (data.recovered) {
        const session = this.recovery.session;
        if (!['signaling-disconnected', 'recovering'].includes(this.recovery.state) ||
            !session || data.code !== session.code || data.role !== session.role ||
            this.acceptedRecoveryGeneration === socketConnectionGeneration ||
            (this.recoveryRequestInFlight &&
              this.recoveryRequestGeneration !== socketConnectionGeneration)) return;
        this.recoveryRequestInFlight = false;
        this.acceptedRecoveryGeneration = socketConnectionGeneration;
      } else {
        if (!this.recovery.establish(data, false)) return;
        this.recoveryRequestInFlight = false;
        this.acceptedRecoveryGeneration = 0;
        this.pendingAbandonSession = null;
      }
      console.log('Devices paired');
      if (this.onPaired) this.onPaired({ ...data, connectionGeneration: socketConnectionGeneration });
    });

    socket.on('signal', ({ data }) => {
      if (this.socket !== socket) return;
      if (this.onSignal) this.onSignal(data, socketConnectionGeneration);
    });

    socket.on('error-message', ({ message }) => {
      if (this.socket !== socket) return;
      console.error('Signaling server error:', message);
      if (this.onError) this.onError(message);
    });

    socket.on('peer-disconnected', (details = {}) => {
      if (this.socket !== socket) return;
      console.warn('Peer disconnected from pairing');
      if (details.recoverable === true) {
        const alreadyRecovering = ['signaling-disconnected', 'recovering'].includes(this.recovery.state);
        if (this.recovery.markRecovering() && !alreadyRecovering) {
          this.acceptedRecoveryGeneration = 0;
        }
      }
      if (this.onPeerDisconnected) this.onPeerDisconnected(details);
    });

    socket.on('recovery-token', ({ recoveryToken } = {}) => {
      if (this.socket !== socket) return;
      this.storeRecoveryTokenAndAcknowledge(
        recoveryToken,
        socket,
        socketConnectionGeneration
      );
    });

    socket.on('recovery-waiting', () => {
      if (this.socket !== socket) return;
      if (!this.recoveryRequestInFlight ||
          this.recoveryRequestGeneration !== socketConnectionGeneration ||
          !this.recovery.markRecovering()) return;
      if (this.onRecoveryWaiting) this.onRecoveryWaiting();
    });

    socket.on('recovery-failed', ({ message } = {}) => {
      if (this.socket !== socket) return;
      if (!['signaling-disconnected', 'recovering'].includes(this.recovery.state)) return;
      const failedSession = this.recovery.session ? { ...this.recovery.session } : null;
      this.recoveryRequestInFlight = false;
      if (!this.recovery.fail()) return;
      this.abandonRecovery(failedSession);
      if (this.onRecoveryFailed) this.onRecoveryFailed(message || 'CONNECT_FAILED');
    });

    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return;
      connectionActive = false;
      this.recoveryRequestInFlight = false;
      this.acceptedRecoveryGeneration = 0;
      const recoverable = this.recovery.markSignalingDisconnected();
      console.warn('Disconnected from signaling server');
      if (this.onDisconnect) this.onDisconnect({ recoverable, reason, generation: this.connectionGeneration });
    });
  }

  requestIceConfig() {
    if (this.socket && this.socket.connected) {
      this.socket.emit('get-ice-config');
    }
  }

  generateCode() {
    if (this.socket) {
      this.abandonCurrentRecovery();
      this.recoveryRequestInFlight = false;
      this.acceptedRecoveryGeneration = 0;
      this.recovery.reset();
      this.socket.emit('generate-code');
    } else {
      console.error('Socket not connected');
    }
  }

  joinCode(code) {
    if (this.socket) {
      this.abandonCurrentRecovery();
      this.recoveryRequestInFlight = false;
      this.acceptedRecoveryGeneration = 0;
      this.recovery.reset();
      this.socket.emit('join-code', { code });
    } else {
      console.error('Socket not connected');
    }
  }

  sendSignal(roomCode, data) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('signal', { room: roomCode, data });
    }
  }

  leaveRoom() {
    this.abandonCurrentRecovery();
    if (this.socket && this.socket.connected) {
      this.socket.emit('leave-room');
    }
    this.recoveryRequestInFlight = false;
    this.acceptedRecoveryGeneration = 0;
    this.recovery.reset();
  }

  recoverSession() {
    if (!this.socket || !this.socket.connected || !this.recovery.session ||
        this.recoveryRequestInFlight) return false;
    this.recovery.markRecovering();
    this.recoveryRequestInFlight = true;
    this.recoveryRequestGeneration = this.connectionGeneration;
    this.socket.emit('recover-session', {
      recoveryToken: this.recovery.session.recoveryToken
    });
    return true;
  }

  completeRecovery() {
    return this.recovery.completeRecovery();
  }

  storeRecoveryTokenAndAcknowledge(recoveryToken, socket, connectionGeneration) {
    if (this.socket !== socket || !socket.connected ||
        !['signaling-disconnected', 'recovering'].includes(this.recovery.state) ||
        this.recoveryRequestGeneration !== connectionGeneration || !this.recovery.session) return false;

    const stored = this.recovery.updateRecoveryCredential({
      ...this.recovery.session,
      recoveryToken
    });
    if (!stored) return false;

    socket.emit('recovery-token-ack', { recoveryToken });
    return true;
  }

  abandonCurrentRecovery() {
    if (!this.recovery.session ||
        !['signaling-disconnected', 'recovering'].includes(this.recovery.state)) return false;
    return this.abandonRecovery({ ...this.recovery.session });
  }

  abandonRecovery(session) {
    if (!this.recovery.isValidSession(session)) return false;
    this.pendingAbandonSession = { ...session };
    return this.flushPendingAbandon();
  }

  flushPendingAbandon() {
    if (!this.pendingAbandonSession || !this.socket || !this.socket.connected) return false;
    this.socket.emit('abandon-recovery', {
      recoveryToken: this.pendingAbandonSession.recoveryToken
    });
    this.pendingAbandonSession = null;
    return true;
  }

  hasRecoverableSession() {
    return Boolean(this.recovery.session);
  }

  sendNetworkHealth(payload) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('network-health', payload);
    }
  }

  sendRelayUsage(bytes) {
    if (this.socket && this.socket.connected) {
      this.socket.emit('relay-usage', { bytes });
    }
  }

  requestRelayUpgrade() {
    if (this.socket && this.socket.connected) {
      this.socket.emit('relay-budget-exhausted');
    }
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = { SocketManager, SessionRecoveryState };
}
