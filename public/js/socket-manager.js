class SocketManager {
  constructor() {
    this.socket = null;
    
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
    this.socket = io(signalingUrl || undefined, {
      transports: ['websocket', 'polling'],
      timeout: 10000,
      reconnection: true
    });

    this.socket.on('connect', () => {
      console.log('Connected to signaling server');
      if (this.onConnect) this.onConnect();
      
      // Request ICE config immediately on connection
      this.requestIceConfig();
    });

    this.socket.on('ice-config', (config) => {
      console.log('Received ICE configuration from server');
      if (this.onIceConfig) this.onIceConfig(config);
    });

    this.socket.on('relay-budget', (budget) => {
      if (this.onRelayBudget) this.onRelayBudget(budget);
    });

    this.socket.on('pro-required', (details) => {
      if (this.onProRequired) this.onProRequired(details);
    });

    this.socket.on('code-generated', (data) => {
      console.log('Pairing code generated');
      if (this.onCodeGenerated) this.onCodeGenerated(data.code);
    });

    this.socket.on('paired', (data) => {
      console.log('Devices paired');
      if (this.onPaired) this.onPaired(data);
    });

    this.socket.on('signal', ({ data }) => {
      if (this.onSignal) this.onSignal(data);
    });

    this.socket.on('error-message', ({ message }) => {
      console.error('Signaling server error:', message);
      if (this.onError) this.onError(message);
    });

    this.socket.on('peer-disconnected', () => {
      console.warn('Peer disconnected from pairing');
      if (this.onPeerDisconnected) this.onPeerDisconnected();
    });

    this.socket.on('disconnect', () => {
      console.warn('Disconnected from signaling server');
      if (this.onDisconnect) this.onDisconnect();
    });
  }

  requestIceConfig() {
    if (this.socket && this.socket.connected) {
      this.socket.emit('get-ice-config');
    }
  }

  generateCode() {
    if (this.socket) {
      this.socket.emit('generate-code');
    } else {
      console.error('Socket not connected');
    }
  }

  joinCode(code) {
    if (this.socket) {
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
    if (this.socket && this.socket.connected) {
      this.socket.emit('leave-room');
    }
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
